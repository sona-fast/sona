import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';
import { load } from './+page.server';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses
// (client.prepare().bind().run()/all()), same approach as sticker-import.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: any): D1Database {
	function exec(sql: string, params: unknown[], mode: 'run' | 'all' | 'raw') {
		const stmt = sqlite.prepare(sql);
		if (mode === 'raw') {
			try {
				return stmt.raw(true).all(...params) as unknown[];
			} finally {
				stmt.raw(false);
			}
		}
		if (stmt.reader) return { results: stmt.all(...params), success: true, meta: {} };
		const info = stmt.run(...params);
		return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
	}
	function prepare(sql: string) {
		return {
			bind: (...params: unknown[]) => ({
				run: () => exec(sql, params, 'run'),
				all: () => exec(sql, params, 'all'),
				raw: () => exec(sql, params, 'raw')
			})
		};
	}
	return { prepare } as unknown as D1Database;
}

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE artists (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
		global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
		aliases TEXT, created_at TEXT NOT NULL
	);
	CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER NOT NULL);
	CREATE TABLE stickers (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER NOT NULL);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function loadEvent(platform: App.Platform) {
	return { platform, url: new URL('http://localhost/admin/artists') } as never;
}

// The registry itself must never be hit from tests: fail every fetch so the
// client's graceful-degradation fallbacks (empty submissions/catalog) apply.
beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('admin artists load — registry enablement', () => {
	it('reports registryEnabled with a D1-stored fork key and no env secret', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });

		const result = await load(loadEvent(platform));
		expect(result).toMatchObject({ registryEnabled: true });
	});

	it('reports registry disabled when nothing is stored and no env secret exists', async () => {
		const { platform } = makeDb();

		const result = await load(loadEvent(platform));
		expect(result).toMatchObject({ registryEnabled: false });
	});
});
