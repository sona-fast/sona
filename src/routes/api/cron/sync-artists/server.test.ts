import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { artists, siteSettings } from '$lib/server/db/schema';
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
		// The reason quotes an upstream body; it stays in job_run, out of the response
		// the sync workflow prints into a public log.
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty('lastDeltaFailure');
		expect(body).not.toHaveProperty('lastSearchFailure');
		expect(body).not.toHaveProperty('lastRateLimit');
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

		// Not a throw: rethrowing became SvelteKit's generic 500 "Internal Error", which
		// is what the workflow log showed while the real reason sat unseen in job_run.
		// The run must still go red (non-2xx), but the body has to name the cause.
		const res = await POST(postEvent(platform));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { ok: boolean; error: string; upstreamStatus: number };
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/401.*invalid fork key/);
		expect(body.upstreamStatus).toBe(401);
		await Promise.all(waits);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const row = (sqlite as any)
			.prepare("SELECT status, detail FROM job_run WHERE name='sync-artists'")
			.get();
		expect(row?.status).toBe('failed');
		expect(row?.status).not.toBe('ok');
		expect(row?.detail).toMatch(/401/);
	});

	// The 2026-09-17 shape: a zone bot rule challenged every Worker fetch to the
	// registry. The delta feed came back 403 with an HTML challenge page, every search
	// came back the same way, and the endpoint answered a bare "Internal Error".
	it('502s with the Cloudflare mitigation named when a challenge page answers the delta feed', async () => {
		const { db, platform, waits, sqlite } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(
					new Response('<html>Just a moment...</html>', {
						status: 403,
						headers: {
							'content-type': 'text/html',
							'cf-mitigated': 'challenge',
							'cf-ray': 'a3e7bc522cbfa3c2-SEA'
						}
					})
				)
			)
		);

		const res = await POST(postEvent(platform));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string; upstreamStatus: number };
		expect(body.error).toContain('blocked by a Cloudflare challenge in front of the registry');
		expect(body.error).toContain('cf-ray a3e7bc522cbfa3c2 SEA');
		expect(body.upstreamStatus).toBe(403);
		await Promise.all(waits);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const row = (sqlite as any).prepare("SELECT status, detail FROM job_run WHERE name='sync-artists'").get();
		expect(row?.status).toBe('failed');
		expect(row?.detail).toContain('Cloudflare challenge');
		// The ray id survives the detail's 20-char token redaction, which is the whole
		// reason it is stored as "<id> <colo>" rather than the raw header value.
		expect(row?.detail).toContain('a3e7bc522cbfa3c2');
	});

	// The workflow prints this body into a PUBLIC Actions log, and the reason is an
	// upstream string we don't control. It gets the same redaction as job_run.detail.
	it('redacts an email or token echoed back inside the registry reason', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'revoked-key' });
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) =>
				String(input).includes('/v1/artists?')
					? Promise.resolve(
							new Response(
								JSON.stringify({
									error: 'no fork for owner@example.com with key sk_live_0123456789abcdefghij'
								}),
								{ status: 401, headers: { 'content-type': 'application/json' } }
							)
						)
					: Promise.reject(new Error('offline'))
			)
		);

		const res = await POST(postEvent(platform));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string };
		expect(body.error).not.toContain('owner@example.com');
		expect(body.error).not.toContain('sk_live_0123456789abcdefghij');
		expect(body.error).toContain('[redacted]');
	});

	// One bad search among several is a degraded run, not a failed one: the counters
	// and the reason land in the job detail while the endpoint still answers 200.
	it('stays 200 and names the degradation when only some searches failed', async () => {
		const { db, platform, waits, sqlite } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		const now = new Date().toISOString();
		await db.insert(artists).values([
			{ name: 'one', twitterUrl: 'https://twitter.com/one', createdAt: now },
			{ name: 'two', twitterUrl: 'https://twitter.com/two', createdAt: now }
		]);
		let searches = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) => {
				if (!String(input).includes('/v1/artists/search'))
					return Promise.resolve(
						new Response(JSON.stringify({ artists: [], nextCursor: null }), {
							status: 200,
							headers: { 'content-type': 'application/json' }
						})
					);
				return Promise.resolve(
					searches++ === 0
						? new Response('bad gateway', { status: 502 })
						: new Response(JSON.stringify({ artists: [] }), {
								status: 200,
								headers: { 'content-type': 'application/json' }
							})
				);
			})
		);

		const res = await POST(postEvent(platform));
		expect(res.status).toBe(200);
		await Promise.all(waits);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const row = (sqlite as any).prepare("SELECT status, detail FROM job_run WHERE name='sync-artists'").get();
		expect(row?.status).toBe('ok');
		expect(row?.detail).toMatch(/searches failed/);
	});

	// The other half of the 2026-09-17 shape: the delta feed was fine but every backfill
	// search was challenged. That run linked nothing and used to answer "ok". It is a
	// search failure, not a key refusal, so no upstreamStatus rides along.
	it('502s naming the backfill when every search is challenged and the feed is healthy', async () => {
		const { db, platform, waits, sqlite } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		const now = new Date().toISOString();
		await db.insert(artists).values([
			{ name: 'one', twitterUrl: 'https://twitter.com/one', createdAt: now },
			{ name: 'two', twitterUrl: 'https://twitter.com/two', createdAt: now },
			{ name: 'three', twitterUrl: 'https://twitter.com/three', createdAt: now }
		]);
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) =>
				Promise.resolve(
					String(input).includes('/v1/artists/search')
						? new Response('<html/>', { status: 403, headers: { 'cf-mitigated': 'challenge' } })
						: new Response(JSON.stringify({ artists: [], nextCursor: null }), {
								status: 200,
								headers: { 'content-type': 'application/json' }
							})
				)
			)
		);

		const res = await POST(postEvent(platform));
		expect(res.status).toBe(502);
		const body = (await res.json()) as {
			ok: boolean;
			error: string;
			upstreamStatus?: number;
		};
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/all 3 backfill searches failed/);
		// Only a refusal carries a status; this one came from the searches.
		expect(body.upstreamStatus).toBeUndefined();
		await Promise.all(waits);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const row = (sqlite as any)
			.prepare("SELECT status, detail FROM job_run WHERE name='sync-artists'")
			.get();
		expect(row?.status).toBe('failed');
	});

	// A D1 failure is still our bug: it must keep propagating as a real 500, not be
	// dressed up as an upstream refusal.
	it('still throws (500) on an unrelated exception such as a database error', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(
					new Response(JSON.stringify({ artists: [], nextCursor: null }), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
				)
			)
		);
		// Drop the table the backfill reads after the gate has passed.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(platform as any).env.DB = {
			prepare: () => {
				throw new Error('D1_ERROR: table gone');
			}
		};

		await expect(POST(postEvent(platform))).rejects.toThrow(/D1_ERROR/);
	});
});
