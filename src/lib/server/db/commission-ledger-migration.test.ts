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
		INSERT INTO artists (id, name, created_at) VALUES (1, 'Artist A', '2026-10-01'), (2, 'Artist B', '2026-10-01');
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
		// Artist 2 has no pieces, so only the entry can refuse the delete.
		sqlite.exec(
			"INSERT INTO commissions (id, artist_id, title, created_at, updated_at) VALUES (1, 2, 'Entry', '2026-10-01', '2026-10-01')"
		);
		expect(() => sqlite.exec('DELETE FROM artists WHERE id = 2')).toThrow(/FOREIGN KEY constraint failed/);
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

	it('creates the artist-lookup indexes and the one-entry-per-piece unique index', () => {
		const sqlite = migrated();
		const indexes = sqlite
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('stickers_artist_id_idx', 'sticker_packs_manager_artist_id_idx', 'avatar_credits_artist_id_idx', 'commissions_artist_id_idx', 'commissions_image_id_uq') ORDER BY name"
			)
			.all() as { name: string; sql: string }[];
		expect(indexes.map((i) => i.name)).toEqual([
			'avatar_credits_artist_id_idx',
			'commissions_artist_id_idx',
			'commissions_image_id_uq',
			'sticker_packs_manager_artist_id_idx',
			'stickers_artist_id_idx'
		]);
		expect(indexes.filter((i) => i.sql.startsWith('CREATE UNIQUE INDEX')).map((i) => i.name)).toEqual(['commissions_image_id_uq']);
	});

	// Q26: the keep-private flag is added in place, so artists that exist before
	// the migration keep their rows and start not private.
	it('adds artists.ledger_private as 0 on rows that existed before it', () => {
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
		for (const name of files.filter((f) => f < '0031')) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
		sqlite.exec("INSERT INTO artists (id, name, created_at) VALUES (1, 'Artist A', '2026-10-01')");
		for (const name of files.filter((f) => f >= '0031')) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
		expect(sqlite.prepare('SELECT id, ledger_private FROM artists').all()).toEqual([{ id: 1, ledger_private: 0 }]);
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

describe('migration 0032 commission receipt_url', () => {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();

	it('adds the column without touching entries saved before it', () => {
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		for (const name of files.filter((f) => f < '0032')) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
		sqlite.exec(`
			INSERT INTO artists (id, name, created_at) VALUES (1, 'Artist A', '2026-10-01');
			INSERT INTO characters (id, name, created_at) VALUES (1, 'Kit', '2026-10-01');
			INSERT INTO commissions (id, artist_id, title, source_url, created_at, updated_at)
				VALUES (1, 1, 'Entry', 'https://example.com/opening', '2026-10-01', '2026-10-01');
			INSERT INTO commission_characters (commission_id, character_id) VALUES (1, 1);
		`);
		sqlite.exec(readFileSync(new URL('0032_commission_receipt_url.sql', dir), 'utf8'));
		expect(sqlite.prepare('SELECT title, source_url, receipt_url FROM commissions').all()).toEqual([
			{ title: 'Entry', source_url: 'https://example.com/opening', receipt_url: null }
		]);
		expect(count(sqlite, 'SELECT COUNT(*) AS n FROM commission_characters')).toBe(1);
	});

	it('is a single ALTER TABLE ... ADD, never a table rebuild', () => {
		const sql = readFileSync(new URL('0032_commission_receipt_url.sql', dir), 'utf8')
			.split('\n')
			.filter((line) => !line.startsWith('--'))
			.join('\n')
			.trim();
		expect(sql).toBe('ALTER TABLE `commissions` ADD `receipt_url` text;');
	});
});
