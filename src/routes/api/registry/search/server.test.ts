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

function getEventQS(platform: App.Platform, qs: string) {
	return { platform, url: new URL(`http://localhost/api/registry/search?${qs}`) } as never;
}

function okJson(body: unknown): Promise<Response> {
	return Promise.resolve(
		new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
	);
}

const REG_ARTIST = {
	globalId: 'g1',
	displayName: 'Kuttoya',
	avatarUrl: null,
	bio: null,
	socials: { twitterUrl: 'https://x.com/kuttoya' },
	status: 'active',
	mergedInto: null,
	version: 2,
	updatedAt: '2026-01-01T00:00:00.000Z'
};

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

describe('GET /api/registry/search — handle search', () => {
	it('forwards a handle param to the registry handle-search and shapes results', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		const fetchMock = vi.fn((_url: unknown) => okJson({ artists: [REG_ARTIST] }));
		vi.stubGlobal('fetch', fetchMock);

		const res = await GET(getEventQS(platform, 'handle=%40kuttoya'));
		expect(fetchMock).toHaveBeenCalled();
		const calledUrl = String(fetchMock.mock.calls[0][0]);
		expect(calledUrl).toContain('/v1/artists/search?handle=');
		expect(await res.json()).toEqual({
			enabled: true,
			artists: [{ globalId: 'g1', name: 'Kuttoya', avatarUrl: null, version: 2, socials: { twitterUrl: 'https://x.com/kuttoya' } }]
		});
	});

	it('prefers handle over q when both are present', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		const fetchMock = vi.fn((_url: unknown) => okJson({ artists: [] }));
		vi.stubGlobal('fetch', fetchMock);

		await GET(getEventQS(platform, 'handle=twitter.com%2Fkuttoya&q=somename'));
		const calledUrl = String(fetchMock.mock.calls[0][0]);
		expect(calledUrl).toContain('handle=');
		expect(calledUrl).not.toContain('q=');
	});

	it('ignores a too-short handle and falls back to the (here empty) q path', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		const fetchMock = vi.fn((_url: unknown) => okJson({ artists: [REG_ARTIST] }));
		vi.stubGlobal('fetch', fetchMock);

		const res = await GET(getEventQS(platform, 'handle=%40'));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await res.json()).toEqual({ enabled: true, artists: [] });
	});
});
