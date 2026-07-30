import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { artists, siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';
import { GET, POST } from './+server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE artists (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
		global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
		aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL
	);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function getEvent(platform: App.Platform) {
	return { platform } as never;
}

function postEvent(platform: App.Platform) {
	return {
		platform,
		request: new Request('http://localhost/api/registry/import', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		})
	} as never;
}

/** Answer the delta feed with one canned status + body; everything else is offline. */
function stubDelta(status: number, body: unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: RequestInfo | URL) =>
			String(input).includes('/v1/artists?')
				? Promise.resolve(
						new Response(JSON.stringify(body), {
							status,
							headers: { 'content-type': 'application/json' }
						})
					)
				: Promise.reject(new Error('offline'))
		)
	);
}

// The registry itself must never be hit from tests.
beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});
afterEach(() => {
	vi.unstubAllGlobals();
});

async function enableRegistry(db: ReturnType<typeof makeDb>['db']) {
	await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
}

describe('GET /api/registry/import', () => {
	// A plan of 0 artists here renders as "the registry is empty" in the New Artist
	// dialog footer — the silent failure the refusal plumbing exists to remove.
	it('502s with the registry reason when the delta feed refuses the key', async () => {
		const { db, platform } = makeDb();
		await enableRegistry(db);
		stubDelta(401, { error: 'invalid fork key' });

		const res = await GET(getEvent(platform));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string; total?: number };
		expect(body.error).toMatch(/invalid fork key/);
		expect(body.total).toBeUndefined();
	});

	// The isRegistryRefusal([]) boundary: a healthy but empty catalogue is a legitimate
	// 200 plan of zero, NOT a refusal.
	it('200s with a zero plan on a healthy empty delta feed', async () => {
		const { db, platform } = makeDb();
		await enableRegistry(db);
		stubDelta(200, { artists: [], nextCursor: null });

		const res = await GET(getEvent(platform));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ enabled: true, total: 0, toCreate: 0, skipped: 0 });
	});
});

describe('POST /api/registry/import', () => {
	it('502s and imports nothing when the delta feed refuses the key', async () => {
		const { db, platform } = makeDb();
		await enableRegistry(db);
		stubDelta(401, { error: 'invalid fork key' });

		const res = await POST(postEvent(platform));
		expect(res.status).toBe(502);
		expect((await res.json()) as { error?: string }).toMatchObject({
			error: expect.stringMatching(/invalid fork key/)
		});
		// No half-import, and no "imported 0 artists" success either.
		expect(await db.select().from(artists)).toHaveLength(0);
	});
});
