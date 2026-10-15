import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';

// A migration that rebuilds a table the way drizzle-kit does (create
// __new_X, copy, DROP TABLE X, rename) fires the ON DELETE actions of every
// table that references X: CASCADE children are deleted and SET NULL links are
// cleared. defer_foreign_keys doesn't prevent it. For images or characters that
// would wipe image_tags, image_characters, and commission_characters, and
// unlink every commission entry (SONA-236 design doc, section 11).
//
// So a new migration may not drop a table that another table references with
// an ON DELETE action, unless it's on the allow-list below with the steps that
// preserve the child rows. Migrations up to 0030 already ran on every fork.
const dir = new URL('../../../../drizzle/', import.meta.url);
const LAST_EXEMPT = 30;

// "NNNN_name.sql:table" for a reviewed rebuild that preserves child rows.
const ALLOWED_REBUILDS: ReadonlySet<string> = new Set([]);

type Migration = { name: string; sql: string };

const migrations: Migration[] = readdirSync(dir)
	.filter((f) => f.endsWith('.sql'))
	.sort()
	.map((name) => ({ name, sql: readFileSync(new URL(name, dir), 'utf8') }));

// Parent table -> children that reference it with an ON DELETE action, as the
// schema stands right now.
function referencedWithAction(sqlite: Database.Database) {
	const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
		(r) => r.name
	);
	const referenced = new Map<string, string[]>();
	for (const child of tables) {
		const fks = sqlite.prepare(`PRAGMA foreign_key_list("${child}")`).all() as { table: string; on_delete: string }[];
		for (const fk of fks) {
			if (fk.on_delete === 'NO ACTION' || fk.on_delete === 'RESTRICT') continue;
			referenced.set(fk.table, [...(referenced.get(fk.table) ?? []), `${child} (${fk.on_delete})`]);
		}
	}
	return referenced;
}

function droppedTables(sql: string): string[] {
	return [...sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi)].map((m) => m[1]);
}

// Replays the migrations in order and checks each drop against the foreign keys
// that exist when that migration runs, so a later migration that removes the
// foreign key can't hide an earlier rebuild that already fired it.
function violations(list: Migration[], lastExempt: number, allowed: ReadonlySet<string>): string[] {
	const sqlite = new Database(':memory:');
	const found: string[] = [];
	for (const m of list) {
		if (Number(m.name.slice(0, 4)) > lastExempt) {
			const referenced = referencedWithAction(sqlite);
			for (const table of droppedTables(m.sql)) {
				const children = referenced.get(table);
				if (children && !allowed.has(`${m.name}:${table}`)) {
					found.push(`${m.name} drops ${table}, which would fire ON DELETE on: ${children.join(', ')}`);
				}
			}
		}
		sqlite.exec(m.sql);
	}
	return found;
}

describe('table rebuild guard', () => {
	it('finds the drop in a drizzle-kit rebuild', () => {
		expect(droppedTables('CREATE TABLE `__new_images` (...);--> statement-breakpoint\nDROP TABLE `images`;')).toEqual([
			'images'
		]);
	});

	it('refuses a new migration that drops a table other tables reference with an ON DELETE action', () => {
		expect(violations(migrations, LAST_EXEMPT, ALLOWED_REBUILDS)).toEqual([]);
	});

	it('catches a rebuild even when a later migration removes the foreign key', () => {
		const rebuildParent =
			'CREATE TABLE `__new_parent` (`id` integer PRIMARY KEY);\nINSERT INTO `__new_parent` SELECT * FROM `parent`;\nDROP TABLE `parent`;\nALTER TABLE `__new_parent` RENAME TO `parent`;';
		const list: Migration[] = [
			{
				name: '0001_init.sql',
				sql: 'CREATE TABLE `parent` (`id` integer PRIMARY KEY);\nCREATE TABLE `child` (`id` integer PRIMARY KEY, `parent_id` integer REFERENCES `parent`(`id`) ON DELETE CASCADE);'
			},
			{ name: '0002_rebuild_parent.sql', sql: rebuildParent },
			{ name: '0003_drop_fk.sql', sql: 'DROP TABLE `child`;\nCREATE TABLE `child` (`id` integer PRIMARY KEY, `parent_id` integer);' }
		];
		expect(violations(list, 1, new Set())).toEqual([
			'0002_rebuild_parent.sql drops parent, which would fire ON DELETE on: child (CASCADE)'
		]);
	});
});
