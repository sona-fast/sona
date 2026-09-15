import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { makeD1, withFailingSettingsRead } from './d1';

function settingsD1() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
		INSERT INTO site_settings (key, value) VALUES ('fuzzysearch_api_key', 'k');
		INSERT INTO artists (name) VALUES ('kuttoya');
	`);
	return withFailingSettingsRead(makeD1(sqlite)) as unknown as {
		prepare: (sql: string) => Record<string, (...args: unknown[]) => unknown>;
	};
}

const D1_ERROR = /D1_ERROR: settings read failed/;

describe('withFailingSettingsRead', () => {
	// A settings read with no parameters calls the terminal straight off the
	// statement. Behind bind only, those calls were undefined, so the read died
	// on a TypeError — which a test asserting the load handles a D1 failure would
	// have credited to the D1 failure it never actually saw.
	it.each(['all', 'run', 'raw', 'first'])('fails an unbound %s with the D1 error', (method) => {
		const stmt = settingsD1().prepare('SELECT value FROM site_settings');
		expect(() => stmt[method]()).toThrow(D1_ERROR);
	});

	it.each(['all', 'run', 'raw', 'first'])('fails a bound %s with the D1 error', (method) => {
		const stmt = settingsD1().prepare('SELECT value FROM site_settings WHERE key = ?');
		const bound = stmt.bind('fuzzysearch_api_key') as Record<string, () => unknown>;
		expect(() => bound[method]()).toThrow(D1_ERROR);
	});

	// batch used to be forwarded as the method itself, which detaches it from the
	// database it belongs to. makeD1's batch is a closure and survives that, so
	// the method is stood up on an object here the way a real D1 binding has it:
	// detached, the call dies on `this`.
	it('keeps batch attached to the database it wraps', () => {
		const inner = {
			marker: 'db',
			prepare: () => ({ bind: () => ({}) }),
			batch(this: { marker: string }) {
				return this.marker;
			}
		} as unknown as D1Database;
		const wrapped = withFailingSettingsRead(inner) as unknown as { batch: () => string };
		expect(wrapped.batch()).toBe('db');
	});

	// Every other table still answers, so a test sees the key read failing rather
	// than a database that is gone.
	it('leaves other tables alone', () => {
		const stmt = settingsD1().prepare('SELECT name FROM artists');
		const bound = stmt.bind() as { all: () => { results: Array<{ name: string }> } };
		expect(bound.all().results).toEqual([{ name: 'kuttoya' }]);
	});
});
