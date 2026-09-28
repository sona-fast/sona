import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';

// Every drizzle migration, applied in order to an empty database, the way
// scripts/setup.ts and the e2e seed build one. The route tests write their own
// CREATE TABLE statements, so this is the only place the shipped SQL runs.
const dir = new URL('../../../../drizzle/', import.meta.url);

function migrated() {
	const sqlite = new Database(':memory:');
	for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
	}
	return sqlite;
}

describe('migration 0030 conventions furtrack_event', () => {
	const insert = (sqlite: ReturnType<typeof migrated>, name: string, tag: string | null) =>
		sqlite
			.prepare("INSERT INTO conventions (name, start_date, furtrack_event, created_at) VALUES (?, '2024-12-05', ?, '')")
			.run(name, tag);

	it('lets any number of conventions stay unlinked', () => {
		const sqlite = migrated();
		insert(sqlite, 'One', null);
		insert(sqlite, 'Two', null);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM conventions WHERE furtrack_event IS NULL').get().n).toBe(2);
	});

	it('refuses a second convention with the same tag', () => {
		const sqlite = migrated();
		insert(sqlite, 'Midwest FurFest 2024', 'MFF 2024');
		expect(() => insert(sqlite, 'Midwest FurFest 2025', 'MFF 2024')).toThrow(
			/UNIQUE constraint failed: conventions\.furtrack_event/
		);
		// A tag differing only by whitespace is a different tag, as the photos
		// store it.
		expect(() => insert(sqlite, 'Midwest FurFest 2025', 'MFF 2024 ')).not.toThrow();
	});
});
