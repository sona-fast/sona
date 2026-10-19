import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';

// drizzle-kit answers some schema edits (a NOT NULL change, a new FK) by
// rebuilding the table: create __new_<table>, copy, DROP the original, rename.
// With foreign keys enforced, that DROP runs an implicit DELETE, which fires
// every child's ON DELETE action. Rebuild `images` and every fork loses its
// image_tags and image_characters rows at deploy, and the
// characters.reference_image_id and vr_avatars.poster_image_id links go NULL.
// The PRAGMA foreign_keys=OFF line drizzle writes can't help: D1 always
// enforces foreign keys and runs each query in an implicit transaction
// (https://developers.cloudflare.com/d1/sql-api/foreign-keys/). The cascade on
// DROP is SQLite's behavior, shown by the test below; it hasn't been run on D1
// itself yet.
//
// A row DELETE, REPLACE INTO, INSERT OR REPLACE, or UPDATE OR REPLACE on a
// parent table (one that another table references with ON DELETE CASCADE,
// SET NULL, or SET DEFAULT) fires the same child actions, row by row.
//
// So a new migration may not rebuild or drop a table, or delete or replace
// rows in a parent table. One that genuinely has to must save and restore its
// children's rows (or show it only removes rows nothing should keep), be
// proven on a local D1, and then be added below by name.
const REVIEWED_REBUILDS = new Set([
	// Rebuilt `stickers` (parent of sticker_emojis). Arrived with 0012 in the
	// baseline commit, so every fork ran it against empty tables.
	'0013_nullable_sticker_artist.sql'
]);
const REVIEWED_ROW_DELETES = new Set([
	// Deletes duplicate `stickers` rows on purpose, after deleting their
	// sticker_emojis itself, so the cascade has nothing left to remove.
	'0019_stickers_dedupe_unique_id.sql'
]);

const DRIZZLE_DIR = new URL('../../../../drizzle/', import.meta.url);
const META_DIR = new URL('meta/', DRIZZLE_DIR);

type Snapshot = {
	tables: Record<string, { foreignKeys?: Record<string, { tableTo: string; onDelete?: string }> }>;
};

/**
 * The tables whose row deletes change other tables: every `tableTo` of a
 * foreign key with a cascade, set null, or set default ON DELETE action, in
 * any of the snapshots. A migration runs against the schema of its own time,
 * so a foreign key a later migration drops still cascades for an earlier one.
 */
function parentTablesFrom(snapshots: Snapshot[]): Set<string> {
	const parents = new Set<string>();
	for (const snapshot of snapshots) {
		for (const table of Object.values(snapshot.tables)) {
			for (const fk of Object.values(table.foreignKeys ?? {})) {
				if (['cascade', 'set null', 'set default'].includes(fk.onDelete?.toLowerCase() ?? '')) {
					parents.add(fk.tableTo.toLowerCase());
				}
			}
		}
	}
	return parents;
}

/** The parent tables across every drizzle snapshot in drizzle/meta. */
function parentTables(): Set<string> {
	const files = readdirSync(META_DIR).filter((f) => /^\d+_snapshot\.json$/.test(f));
	if (files.length === 0) throw new Error('no drizzle snapshot in drizzle/meta');
	return parentTablesFrom(
		files.map((f) => JSON.parse(readFileSync(new URL(f, META_DIR), 'utf8')) as Snapshot)
	);
}

const PARENT_TABLES = parentTables();

/**
 * A migration's statements with comments blanked and string literals emptied,
 * so prose can't trip the guard and `DROP/**\/TABLE` can't slip past it. A
 * single-quoted bare word is kept: SQLite also reads 'images' as a table name
 * after DELETE FROM and the like, and a lone word can't spell a statement.
 * Quoted identifiers (`x`, "x", [x]) are matched first and kept as written, so
 * a quote or `--` inside one can't swallow the code after it. Blanking runs
 * before the split, so a breakpoint marker inside a literal or comment can't
 * cut a statement in two; the real marker is kept to split on.
 */
function statements(sql: string): string[] {
	return sql
		.replace(
			/`(?:[^`]|``)*`|"(?:[^"]|"")*"|\[[^\]]*\]|'(?:[^']|'')*'|--> statement-breakpoint|--[^\n]*|\/\*[\s\S]*?\*\//g,
			(m) =>
				m === '--> statement-breakpoint'
					? m
					: m[0] === "'"
						? /^'\w+'$/.test(m)
							? m
							: "''"
						: m[0] === '-' || m[0] === '/'
							? ' '
							: m
		)
		.split('--> statement-breakpoint')
		.map((s) => s.trim());
}

/** The statements in a migration that rebuild or drop a table. */
function rebuildStatements(sql: string): string[] {
	return statements(sql).filter((c) => /\b__new_\w+/i.test(c) || /\bDROP\s+TABLE\b/i.test(c));
}

/** A table name, bare or quoted, with an optional schema prefix; group 1 is the name. */
const TABLE = String.raw`(?:(?:\w+|\x60[^\x60]*\x60|"[^"]*"|'\w+'|\[[^\]]*\])\s*\.\s*)?[\x60"'\[]?(\w+)[\x60"'\]]?`;
const ROW_DELETE = new RegExp(
	String.raw`\b(?:DELETE\s+FROM|REPLACE\s+INTO|UPDATE\s+OR\s+REPLACE)(?:\s+|\s*(?=[\x60"'\[]))` + TABLE,
	'gi'
);

/**
 * The statements in a migration that delete or replace rows in a parent table.
 * `REPLACE\s+INTO` also matches `INSERT OR REPLACE INTO`.
 */
function parentDeleteStatements(sql: string): string[] {
	return statements(sql).filter((c) =>
		[...c.matchAll(ROW_DELETE)].some((m) => PARENT_TABLES.has(m[1].toLowerCase()))
	);
}

describe('migration rebuild guard', () => {
	it('no migration rebuilds or drops a table unless it was reviewed for FK actions', () => {
		const files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql'));
		expect(files.length).toBeGreaterThan(0);

		const unreviewed = files
			.filter((f) => !REVIEWED_REBUILDS.has(f))
			.filter((f) => rebuildStatements(readFileSync(new URL(f, DRIZZLE_DIR), 'utf8')).length > 0);

		expect(unreviewed, 'see the comment at the top of this file').toEqual([]);
	});

	it('no migration deletes or replaces parent-table rows unless it was reviewed for FK actions', () => {
		const files = readdirSync(DRIZZLE_DIR).filter((f) => f.endsWith('.sql'));
		expect(files.length).toBeGreaterThan(0);

		const unreviewed = files
			.filter((f) => !REVIEWED_ROW_DELETES.has(f))
			.filter((f) => parentDeleteStatements(readFileSync(new URL(f, DRIZZLE_DIR), 'utf8')).length > 0);

		expect(unreviewed, 'see the comment at the top of this file').toEqual([]);
	});

	it('every reviewed migration still names a file in drizzle/ and still trips its check', () => {
		const files = new Set(readdirSync(DRIZZLE_DIR));
		expect([...REVIEWED_REBUILDS, ...REVIEWED_ROW_DELETES].filter((f) => !files.has(f))).toEqual([]);
		const sql = (f: string) => readFileSync(new URL(f, DRIZZLE_DIR), 'utf8');
		expect([...REVIEWED_REBUILDS].filter((f) => rebuildStatements(sql(f)).length === 0)).toEqual([]);
		expect([...REVIEWED_ROW_DELETES].filter((f) => parentDeleteStatements(sql(f)).length === 0)).toEqual([]);
	});

	it('derives the parent tables from the schema snapshots', () => {
		// A parsing break must not empty the set and pass every migration.
		expect(PARENT_TABLES).toContain('images');
		expect(PARENT_TABLES).toContain('characters');
		expect(PARENT_TABLES).not.toContain('image_tags');
	});

	it('keeps a parent whose cascading foreign key a later snapshot dropped', () => {
		const fk = (onDelete: string) => ({ stickers: { foreignKeys: { f: { tableTo: 'sticker_packs', onDelete } } } });
		const parents = parentTablesFrom([{ tables: fk('cascade') }, { tables: fk('no action') }]);
		expect(parents).toContain('sticker_packs');
		expect(parentTablesFrom([{ tables: fk('no action') }])).not.toContain('sticker_packs');
	});

	it('flags row deletes and replaces on a parent table', () => {
		expect(parentDeleteStatements('DELETE FROM `images` WHERE `id` = 1;')).toHaveLength(1);
		expect(parentDeleteStatements('delete from main.images;')).toHaveLength(1);
		expect(parentDeleteStatements('REPLACE INTO `characters` (`id`, `name`) VALUES (1, \'x\');')).toHaveLength(1);
		expect(parentDeleteStatements('INSERT OR REPLACE INTO "characters" ("id") VALUES (1);')).toHaveLength(1);
		expect(parentDeleteStatements('UPDATE OR REPLACE [characters] SET name = \'x\';')).toHaveLength(1);
		// SQLite needs no space before a quoted table name.
		expect(parentDeleteStatements('DELETE FROM`images`;')).toHaveLength(1);
		expect(parentDeleteStatements('DELETE FROM"images";')).toHaveLength(1);
		expect(parentDeleteStatements('DELETE FROM[images];')).toHaveLength(1);
		expect(parentDeleteStatements('REPLACE INTO`images` (`id`) VALUES (1);')).toHaveLength(1);
		// SQLite also takes a single-quoted string as a table name here.
		expect(parentDeleteStatements("DELETE FROM 'images';")).toHaveLength(1);
		expect(parentDeleteStatements("DELETE FROM'images';")).toHaveLength(1);
		expect(parentDeleteStatements("REPLACE INTO 'images' ('id') VALUES (1);")).toHaveLength(1);
		expect(parentDeleteStatements("UPDATE OR REPLACE 'characters' SET name = 'x';")).toHaveLength(1);
		expect(parentDeleteStatements("DELETE FROM 'main'.'images';")).toHaveLength(1);
		expect(
			parentDeleteStatements('DELETE FROM `image_tags`;\n--> statement-breakpoint\nDELETE FROM `images`;')
		).toHaveLength(1);
	});

	it('leaves leaf tables and plain writes on parents alone', () => {
		expect(parentDeleteStatements('DELETE FROM `image_tags` WHERE `tag_id` = 1;')).toEqual([]);
		expect(parentDeleteStatements('DELETE FROM `sessions`;')).toEqual([]);
		expect(parentDeleteStatements('INSERT INTO `images` (`id`) VALUES (1);')).toEqual([]);
		expect(parentDeleteStatements("UPDATE `characters` SET `name` = replace(`name`, 'a', 'b');")).toEqual([]);
		expect(parentDeleteStatements("UPDATE `site_config` SET `note` = 'delete from images';")).toEqual([]);
		expect(parentDeleteStatements("UPDATE `site_config` SET `note` = 'images';")).toEqual([]);
		expect(parentDeleteStatements('-- delete from images\nCREATE INDEX `z` ON `images` (`id`);')).toEqual([]);
	});

	it('does not split on a breakpoint marker inside a literal or comment', () => {
		expect(rebuildStatements("SELECT '--> statement-breakpoint'; DROP TABLE images; SELECT 'x';")).toHaveLength(1);
		expect(rebuildStatements('/* --> statement-breakpoint */ DROP TABLE images; SELECT 1;')).toHaveLength(1);
		expect(
			parentDeleteStatements("SELECT '--> statement-breakpoint'; DELETE FROM images; SELECT 'x';")
		).toHaveLength(1);
	});

	it('catches the rebuild drizzle-kit generates, and the data loss it causes', () => {
		// The shape drizzle-kit writes for a column change on a referenced table.
		const generated = [
			'PRAGMA foreign_keys=OFF;',
			'CREATE TABLE `__new_images` (`id` integer PRIMARY KEY, `title` text NOT NULL);',
			'INSERT INTO `__new_images`("id", "title") SELECT "id", "title" FROM `images`;',
			'DROP TABLE `images`;',
			'ALTER TABLE `__new_images` RENAME TO `images`;',
			'PRAGMA foreign_keys=ON;'
		].join('\n--> statement-breakpoint\n');
		expect(rebuildStatements(generated)).toHaveLength(4);

		// Run the file as one transaction, with foreign keys on as D1 has them;
		// inside a transaction the PRAGMA is a no-op, as on D1's per-query
		// transactions. The image survives the rebuild; its tag row does not.
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec(`CREATE TABLE images (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
			CREATE TABLE image_tags (image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL);
			INSERT INTO images VALUES (1, 'art');
			INSERT INTO image_tags VALUES (1, 7);`);
		sqlite.transaction(() => {
			for (const stmt of generated.split('--> statement-breakpoint')) {
				sqlite.exec(stmt);
				// Still on after `PRAGMA foreign_keys=OFF;`, so the DROP cascades.
				expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
			}
		})();
		expect(sqlite.prepare('SELECT count(*) AS n FROM images').get()).toEqual({ n: 1 });
		expect(sqlite.prepare('SELECT count(*) AS n FROM image_tags').get()).toEqual({ n: 0 });
	});

	it('leaves additive migrations alone', () => {
		expect(rebuildStatements('CREATE INDEX IF NOT EXISTS `x_idx` ON `images` (`artist_id`);')).toEqual([]);
		expect(rebuildStatements('ALTER TABLE `images` ADD `nsfw` integer DEFAULT 0 NOT NULL;')).toEqual([]);
		expect(rebuildStatements('DROP INDEX IF EXISTS `x_idx`;')).toEqual([]);
	});

	it('ignores comments and string literals that mention a drop', () => {
		expect(rebuildStatements('-- we never drop table rows here\nCREATE INDEX `y_idx` ON `images` (`id`);')).toEqual([]);
		expect(rebuildStatements('/* no DROP TABLE, no __new_images */ SELECT 1;')).toEqual([]);
		expect(rebuildStatements("UPDATE `site_config` SET `note` = 'drop table it''s fine';")).toEqual([]);
	});

	it('sees through comments hiding a rebuild, in any case', () => {
		expect(rebuildStatements('DROP/**/TABLE images;')).toHaveLength(1);
		expect(rebuildStatements('drop table `images`; -- tidy up')).toHaveLength(1);
		expect(rebuildStatements('CREATE TABLE `__NEW_images` (`id` integer);')).toHaveLength(1);
		// A quote or comment marker inside a quoted identifier must not hide a later DROP.
		expect(
			rebuildStatements("ALTER TABLE `images` ADD `artist's_note` text;\nDROP TABLE `images`;\n-- '")
		).toHaveLength(1);
		expect(rebuildStatements('CREATE TABLE `a--b` (x); DROP TABLE `images`;')).toHaveLength(1);
		expect(rebuildStatements('ALTER TABLE "o\'brien" ADD x integer; DROP TABLE images; SELECT \'z\';')).toHaveLength(1);
	});
});
