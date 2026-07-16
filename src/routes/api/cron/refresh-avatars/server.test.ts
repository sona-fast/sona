import { describe, it, expect, vi, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { POST } from './+server';

const CRON_SECRET = 'test-cron-secret';

const DDL = `
CREATE TABLE artists (
	id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
	bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT,
	patreon_url TEXT, instagram_url TEXT, global_id TEXT, registry_version INTEGER,
	registry_synced_at TEXT, aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function makeEnv() {
	const sqlite = new Database(':memory:');
	sqlite.exec(DDL);
	return { CRON_SECRET, DB: makeD1(sqlite) } as unknown as App.Platform['env'];
}

function postEvent(env: App.Platform['env'], { secret, batch }: { secret?: string; batch?: string } = {}) {
	const url = new URL('http://localhost/api/cron/refresh-avatars');
	if (batch !== undefined) url.searchParams.set('batch', batch);
	const request = new Request(url, {
		method: 'POST',
		headers: secret ? { authorization: `Bearer ${secret}` } : {}
	});
	return { request, url, platform: { env } } as never;
}

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/cron/refresh-avatars', () => {
	it('rejects requests without a valid cron secret', async () => {
		const env = makeEnv();
		await expect(POST(postEvent(env, { secret: '' }))).rejects.toMatchObject({ status: 401 });
		await expect(POST(postEvent(env, { secret: 'wrong' }))).rejects.toMatchObject({ status: 401 });
	});

	it('refuses to run when no CRON_SECRET is configured (fail closed)', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(DDL);
		const env = { DB: makeD1(sqlite) } as unknown as App.Platform['env'];
		await expect(POST(postEvent(env, { secret: 'anything' }))).rejects.toMatchObject({ status: 503 });
	});

	it('runs a bounded refresh and reports counts (empty table = zero summary)', async () => {
		// No fetch should be needed with no artists, but stub it so an accidental
		// network call fails loudly instead of hitting the real internet.
		vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
		const env = makeEnv();
		const res = await POST(postEvent(env, { secret: CRON_SECRET, batch: '5' }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ processed: 0, refreshed: 0, remaining: 0 });
	});
});
