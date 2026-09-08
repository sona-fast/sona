import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';

describe('migration 0029 image_tags image_id index', () => {
	// Runs the REAL migration SQL, like the 0022 artist-index test, so the file is
	// known to apply cleanly and create the index the Suggest tags load depends on.
	it('applies cleanly and creates image_tags_image_id_idx', () => {
		const sqlite = new Database(':memory:');
		sqlite.exec('CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);');
		const migration = readFileSync(
			new URL('../../../../drizzle/0029_image_tags_image_id_idx.sql', import.meta.url),
			'utf8'
		);
		for (const stmt of migration.split('--> statement-breakpoint')) sqlite.exec(stmt);
		const indexes = sqlite.prepare("PRAGMA index_list('image_tags')").all() as { name: string }[];
		expect(indexes.map((i) => i.name)).toContain('image_tags_image_id_idx');

		// A fork that already carries the index must not fail the deploy on it.
		for (const stmt of migration.split('--> statement-breakpoint')) sqlite.exec(stmt);
	});
});
