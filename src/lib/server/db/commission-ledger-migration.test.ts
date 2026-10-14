import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';

// Every drizzle migration applied in order, with foreign keys ON as D1 runs
// them. The test shim leaves foreign keys off, so these invariants are checked
// here against the shipped SQL.
const dir = new URL('../../../../drizzle/', import.meta.url);

function migrated() {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');
	for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
	}
	sqlite.exec(`
		INSERT INTO artists (id, name, created_at) VALUES (1, 'Artist A', '2026-10-01');
		INSERT INTO characters (id, name, created_at) VALUES (1, 'Kit', '2026-10-01'), (2, 'Pip', '2026-10-01');
		INSERT INTO images (id, slug, title, image_url, artist_id, created_at) VALUES (1, 'snowfall', 'Snowfall', '/a.png', 1, '2026-10-01');
	`);
	return sqlite;
}

const entry = (sqlite: ReturnType<typeof migrated>, id: number, imageId: number | null) =>
	sqlite
		.prepare(
			"INSERT INTO commissions (id, artist_id, title, image_id, created_at, updated_at) VALUES (?, 1, 'Entry', ?, '2026-10-01', '2026-10-01')"
		)
		.run(id, imageId);
const count = (sqlite: ReturnType<typeof migrated>, sql: string) => (sqlite.prepare(sql).get() as { n: number }).n;

describe('migration 0031 commission ledger', () => {
	it('keeps an entry and clears its link when its piece is deleted', () => {
		const sqlite = migrated();
		entry(sqlite, 1, 1);
		sqlite.exec('DELETE FROM images WHERE id = 1');
		expect(sqlite.prepare('SELECT image_id FROM commissions WHERE id = 1').get()).toEqual({ image_id: null });
	});

	it('keeps an entry and drops only the link when a character is deleted', () => {
		const sqlite = migrated();
		entry(sqlite, 1, null);
		sqlite.exec('INSERT INTO commission_characters (commission_id, character_id) VALUES (1, 1), (1, 2)');
		sqlite.exec('DELETE FROM characters WHERE id = 1');
		expect(count(sqlite, 'SELECT COUNT(*) AS n FROM commissions')).toBe(1);
		expect(sqlite.prepare('SELECT character_id FROM commission_characters').all()).toEqual([{ character_id: 2 }]);
	});

	it('removes an entry\'s character links with the entry', () => {
		const sqlite = migrated();
		entry(sqlite, 1, null);
		sqlite.exec('INSERT INTO commission_characters (commission_id, character_id) VALUES (1, 1)');
		sqlite.exec('DELETE FROM commissions WHERE id = 1');
		expect(count(sqlite, 'SELECT COUNT(*) AS n FROM commission_characters')).toBe(0);
	});

	it('refuses to delete an artist who has entries', () => {
		const sqlite = migrated();
		entry(sqlite, 1, null);
		expect(() => sqlite.exec('DELETE FROM artists WHERE id = 1')).toThrow(/FOREIGN KEY constraint failed/);
		expect(count(sqlite, 'SELECT COUNT(*) AS n FROM commissions')).toBe(1);
	});

	it('links a piece to at most one entry, while any number of entries stay unlinked', () => {
		const sqlite = migrated();
		entry(sqlite, 1, 1);
		expect(() => entry(sqlite, 2, 1)).toThrow(/UNIQUE constraint failed: commissions\.image_id/);
		entry(sqlite, 3, null);
		entry(sqlite, 4, null);
		expect(count(sqlite, 'SELECT COUNT(*) AS n FROM commissions WHERE image_id IS NULL')).toBe(2);
	});

	it('refuses the same character twice on one entry', () => {
		const sqlite = migrated();
		entry(sqlite, 1, null);
		sqlite.exec('INSERT INTO commission_characters (commission_id, character_id) VALUES (1, 1)');
		expect(() => sqlite.exec('INSERT INTO commission_characters (commission_id, character_id) VALUES (1, 1)')).toThrow(
			/UNIQUE constraint failed/
		);
	});

	it('starts a new entry as applied and unpaid', () => {
		const sqlite = migrated();
		entry(sqlite, 1, null);
		expect(sqlite.prepare('SELECT status, payment FROM commissions WHERE id = 1').get()).toEqual({
			status: 'applied',
			payment: 'unpaid'
		});
	});
});
