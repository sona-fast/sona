import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';
import { GET } from './+server';

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
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function getEvent(platform: App.Platform, q: string) {
	return { platform, url: new URL(`http://localhost/api/registry/search?q=${q}`) } as never;
}

// The registry itself must never be hit from tests (the short-q path below
// returns before any fetch, but keep the stub as a hermeticity backstop).
beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('GET /api/registry/search — registry enablement', () => {
	it('does not short-circuit to disabled when a D1-stored fork key exists (no env secret)', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });

		// q too short to trigger an outbound search — proves only the enabled-gate.
		const res = await GET(getEvent(platform, 'a'));
		expect(await res.json()).toEqual({ enabled: true, artists: [] });
	});

	it('reports disabled when nothing is stored and no env secret exists', async () => {
		const { platform } = makeDb();

		const res = await GET(getEvent(platform, 'a'));
		expect(await res.json()).toEqual({ enabled: false, artists: [] });
	});
});
