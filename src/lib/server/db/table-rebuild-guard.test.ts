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

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

function referencedWithAction() {
	const sqlite = new Database(':memory:');
	for (const f of files) sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
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

describe('table rebuild guard', () => {
	it('finds the drop in a drizzle-kit rebuild', () => {
		expect(droppedTables('CREATE TABLE `__new_images` (...);--> statement-breakpoint\nDROP TABLE `images`;')).toEqual([
			'images'
		]);
	});

	it('refuses a new migration that drops a table other tables reference with an ON DELETE action', () => {
		const referenced = referencedWithAction();
		const violations: string[] = [];
		for (const f of files) {
			if (Number(f.slice(0, 4)) <= LAST_EXEMPT) continue;
			for (const table of droppedTables(readFileSync(new URL(f, dir), 'utf8'))) {
				const children = referenced.get(table);
				if (children && !ALLOWED_REBUILDS.has(`${f}:${table}`)) {
					violations.push(`${f} drops ${table}, which would fire ON DELETE on: ${children.join(', ')}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
