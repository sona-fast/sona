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
// The PRAGMA foreign_keys=OFF line drizzle writes doesn't help inside the
// transaction the migration runs in.
//
// So a new migration may not rebuild a table. One that genuinely has to must
// save and restore its children's rows, be proven on a local D1, and then be
// added here by name.
const REVIEWED_REBUILDS = new Set([
	// Rebuilt `stickers` (parent of sticker_emojis). Arrived with 0012 in the
	// baseline commit, so every fork ran it against empty tables.
	'0013_nullable_sticker_artist.sql'
]);

const DRIZZLE_DIR = new URL('../../../../drizzle/', import.meta.url);

/** The statements in a migration that rebuild or drop a table. */
function rebuildStatements(sql: string): string[] {
	return sql
		.split('--> statement-breakpoint')
		.map((s) => s.trim())
		.filter((s) => /\b__new_\w+/.test(s) || /\bDROP\s+TABLE\b/i.test(s));
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

		// Run as one transaction, the way the migration runner applies a file.
		// The image survives the rebuild; its tag row does not.
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec(`CREATE TABLE images (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
			CREATE TABLE image_tags (image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL);
			INSERT INTO images VALUES (1, 'art');
			INSERT INTO image_tags VALUES (1, 7);`);
		sqlite.transaction(() => {
			for (const stmt of generated.split('--> statement-breakpoint')) sqlite.exec(stmt);
		})();
		expect(sqlite.prepare('SELECT count(*) AS n FROM images').get()).toEqual({ n: 1 });
		expect(sqlite.prepare('SELECT count(*) AS n FROM image_tags').get()).toEqual({ n: 0 });
	});

	it('leaves additive migrations alone', () => {
		expect(rebuildStatements('CREATE INDEX IF NOT EXISTS `x_idx` ON `images` (`artist_id`);')).toEqual([]);
		expect(rebuildStatements('ALTER TABLE `images` ADD `nsfw` integer DEFAULT 0 NOT NULL;')).toEqual([]);
	});
});
