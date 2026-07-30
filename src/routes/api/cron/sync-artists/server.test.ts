import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';
import { POST } from './+server';

import { makeD1 } from '$lib/server/test/d1';

const CRON_SECRET = 'test-cron-secret';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE artists (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
		global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
		aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL
	);
	CREATE TABLE job_run (name TEXT PRIMARY KEY, status TEXT NOT NULL, ran_at TEXT NOT NULL, detail TEXT);`);
	const d1 = makeD1(sqlite);
	// Capture the fire-and-forget observability writes (recordJobRun) so a test can
	// await them before asserting the heartbeat row.
	const waits: Promise<unknown>[] = [];
	return {
		sqlite,
		waits,
		db: drizzle(d1, { schema }),
		platform: {
			env: { DB: d1, CRON_SECRET },
			context: { waitUntil: (p: Promise<unknown>) => waits.push(p) }
		} as unknown as App.Platform
	};
}

function postEvent(platform: App.Platform) {
	const request = new Request('http://localhost/api/cron/sync-artists', {
		method: 'POST',
		headers: { authorization: `Bearer ${CRON_SECRET}` }
	});
	return { request, platform } as never;
}

// The registry itself must never be hit from tests: fail every fetch so the
// client's graceful-degradation fallbacks (empty delta feed) apply.
beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('POST /api/cron/sync-artists — registry enablement gate', () => {
	it('passes the gate with a D1-stored fork key and no env secret', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });

		const res = await POST(postEvent(platform));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; skipped?: boolean };
		expect(body.ok).toBe(true);
		expect(body.skipped).toBeUndefined();
	});

	it('503s when nothing is stored and no env secret exists', async () => {
		const { platform } = makeDb();

		await expect(POST(postEvent(platform))).rejects.toMatchObject({ status: 503 });
	});
});

describe('POST /api/cron/sync-artists — observability heartbeat (issue #6)', () => {
	it('records a job_run "ok" row on a successful run', async () => {
		const { db, platform, waits, sqlite } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });

		const res = await POST(postEvent(platform));
		expect(res.status).toBe(200);
		// The heartbeat write is scheduled fire-and-forget; drain it before asserting.
		await Promise.all(waits);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const row = (sqlite as any).prepare("SELECT status FROM job_run WHERE name='sync-artists'").get();
		expect(row?.status).toBe('ok');
	});

	// The reachable-today shape: the registry's read limiter is keyed on the eyeball IP,
	// which a cron subrequest doesn't have, so every fork shares one bucket. A 429 is
	// transient — it must stay a no-op run, not a failed job.
	it('stays "ok" when the delta feed rate-limits (429), not "failed"', async () => {
		const { db, platform, waits, sqlite } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) =>
				String(input).includes('/v1/artists?')
					? Promise.resolve(
							new Response(JSON.stringify({ error: 'rate limited — slow down' }), {
								status: 429,
								headers: { 'content-type': 'application/json' }
							})
						)
					: Promise.reject(new Error('offline'))
			)
		);

		const res = await POST(postEvent(platform));
		expect(res.status).toBe(200);
		await Promise.all(waits);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const row = (sqlite as any).prepare("SELECT status FROM job_run WHERE name='sync-artists'").get();
		expect(row?.status).toBe('ok');
	});

	// A refused fork key must not read as a healthy zero-artist run: the panel would
	// show "ok" forever while nothing ever imported again. The regression is `ok`.
	it('records "failed" (not "ok") with the status when the delta feed refuses the key', async () => {
		const { db, platform, waits, sqlite } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'revoked-key' });
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) =>
				String(input).includes('/v1/artists?')
					? Promise.resolve(
							new Response(JSON.stringify({ error: 'invalid fork key' }), {
								status: 401,
								headers: { 'content-type': 'application/json' }
							})
						)
					: Promise.reject(new Error('offline'))
			)
		);

		await expect(POST(postEvent(platform))).rejects.toThrow(/401.*invalid fork key/);
		await Promise.all(waits);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const row = (sqlite as any)
			.prepare("SELECT status, detail FROM job_run WHERE name='sync-artists'")
			.get();
		expect(row?.status).toBe('failed');
		expect(row?.status).not.toBe('ok');
		expect(row?.detail).toMatch(/401/);
	});
});
