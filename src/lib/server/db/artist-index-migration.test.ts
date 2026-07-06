import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';

describe('migration 0022 images artist_id index', () => {
	// Runs the REAL migration SQL (same pattern as the sticker-import migration
	// tests) so the file is known to apply cleanly and create the index.
	it('applies cleanly and creates images_artist_id_idx', () => {
		const sqlite = new Database(':memory:');
		sqlite.exec('CREATE TABLE images (id INTEGER PRIMARY KEY, artist_id INTEGER NOT NULL);');
		const migration = readFileSync(new URL('../../../../drizzle/0022_add_images_artist_id_index.sql', import.meta.url), 'utf8');
		for (const stmt of migration.split('--> statement-breakpoint')) sqlite.exec(stmt);
		const indexes = sqlite.prepare("PRAGMA index_list('images')").all() as { name: string }[];
		expect(indexes.map((i) => i.name)).toContain('images_artist_id_idx');
	});
});
