import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { clearSettingsCache } from '$lib/server/settings';
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
CREATE TABLE job_run (name TEXT PRIMARY KEY, status TEXT NOT NULL, ran_at TEXT NOT NULL, detail TEXT);
`;

function makeEnv() {
	const sqlite = new Database(':memory:');
	sqlite.exec(DDL);
	return { CRON_SECRET, DB: makeD1(sqlite) } as unknown as App.Platform['env'];
}

function postEvent(
	env: App.Platform['env'],
	{ secret, batch, waits }: { secret?: string; batch?: string; waits?: Promise<unknown>[] } = {}
) {
	const url = new URL('http://localhost/api/cron/refresh-avatars');
	if (batch !== undefined) url.searchParams.set('batch', batch);
	const request = new Request(url, {
		method: 'POST',
		headers: secret ? { authorization: `Bearer ${secret}` } : {}
	});
	// The heartbeat write is scheduled fire-and-forget; capturing it lets a test
	// await the write before asserting the job_run row.
	const context = waits ? { waitUntil: (p: Promise<unknown>) => waits.push(p) } : undefined;
	return { request, url, platform: { env, context } } as never;
}

// getSettings memoizes at module scope for 60s and the entry is shared by every
// test in this file, so without this a seeded test can read an earlier test's
// cached defaults and pass for the wrong reason.
beforeEach(() => clearSettingsCache());
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
		// ownerAvatar rides along in the response: these seeds set no blueskyUrl, so
		// the heal is skipped without a lookup, which is the healthy-fork path.
		expect(await res.json()).toEqual({
			processed: 0,
			refreshed: 0,
			remaining: 0,
			ownerAvatar: 'skipped'
		});
	});

	it('clamps an oversized batch to MAX_BATCH (50) so a run fits the workflow curl ceiling', async () => {
		// Every resolve fails fast offline; only the clamp arithmetic is under test.
		vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
		const sqlite = new Database(':memory:');
		sqlite.exec(DDL);
		const rows = Array.from({ length: 60 }, (_, i) => `('a${i}', 'a${i}.bsky.social', 'x')`).join(',');
		sqlite.exec(`INSERT INTO artists (name, bluesky_url, created_at) VALUES ${rows};`);
		const env = { CRON_SECRET, DB: makeD1(sqlite) } as unknown as App.Platform['env'];

		const res = await POST(postEvent(env, { secret: CRON_SECRET, batch: '999' }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			processed: 50,
			refreshed: 0,
			remaining: 10,
			ownerAvatar: 'skipped'
		});
	});
});

// The heal is the reason this endpoint changed, so it gets its own coverage AT
// the endpoint: the tests above pin only the skipped path, which is the value
// the handler initializes to — they would stay green if the call were removed.
describe('POST /api/cron/refresh-avatars — the owner-avatar heal', () => {
	const BSKY_AVATAR = 'https://cdn.bsky.app/img/avatar/plain/did/abc@jpeg';

	/** A fork stranded on a hotlink: a handle to resolve from, R2 with a CDN base. */
	function strandedEnv() {
		const sqlite = new Database(':memory:');
		sqlite.exec(DDL);
		sqlite.exec(`INSERT INTO site_settings (key, value) VALUES
			('blueskyUrl', 'https://bsky.app/profile/nova.bsky.social'),
			('adminAvatarUrl', '${BSKY_AVATAR}'),
			('storageProvider', 'r2'),
			('r2PublicUrl', 'https://cdn.test');`);
		const bucket = {
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {}),
			list: vi.fn(async () => ({ objects: [], truncated: false }))
		};
		const env = { CRON_SECRET, DB: makeD1(sqlite), IMAGES: bucket } as unknown as App.Platform['env'];
		return { sqlite, env, bucket };
	}

	/** Profile lookup → an avatar; anything else → the image bytes. */
	function stubProfileAndImage() {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL) =>
				String(input).includes('getProfile')
					? new Response(JSON.stringify({ avatar: BSKY_AVATAR }), { status: 200 })
					: new Response(new Uint8Array([1, 2, 3, 4]), {
							status: 200,
							headers: { 'content-type': 'image/jpeg' }
						})
			)
		);
	}

	function jobRow(sqlite: unknown) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (sqlite as any)
			.prepare("SELECT status, detail FROM job_run WHERE name='refresh-avatars'")
			.get();
	}

	it('re-hosts the stranded owner avatar and says so in the response and the heartbeat', async () => {
		stubProfileAndImage();
		const { sqlite, env, bucket } = strandedEnv();
		const waits: Promise<unknown>[] = [];

		const res = await POST(postEvent(env, { secret: CRON_SECRET, batch: '5', waits }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			processed: 0,
			refreshed: 0,
			remaining: 0,
			ownerAvatar: 'healed'
		});

		expect(bucket.put).toHaveBeenCalled();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const stored = (sqlite as any)
			.prepare("SELECT value FROM site_settings WHERE key='adminAvatarUrl'")
			.get();
		expect(stored.value).toMatch(/^https:\/\/cdn\.test\/avatars\/owner\//);

		await Promise.all(waits);
		const job = jobRow(sqlite);
		expect(job.status).toBe('ok');
		expect(job.detail).toBe('refreshed 0/0, 0 remaining, owner avatar now self-hosted');
	});

	// Ordering is load-bearing, not cosmetic: behind the artist batch the heal sits
	// downstream of the workflow's curl --max-time, and a batch that burns the
	// budget cancels the request before it runs — every day, since mode 'oldest'
	// never drains. Call order is the only observable, so pin it.
	it('runs the heal before the artist batch, not behind it', async () => {
		stubProfileAndImage();
		const { sqlite, env } = strandedEnv();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(sqlite as any).exec(
			"INSERT INTO artists (name, bluesky_url, created_at) VALUES ('Nova', 'artist.bsky.social', 'x');"
		);

		const res = await POST(postEvent(env, { secret: CRON_SECRET, batch: '5' }));
		expect(res.status).toBe(200);

		const lookups = vi
			.mocked(globalThis.fetch)
			.mock.calls.map((c) => String(c[0]))
			.filter((u) => u.includes('getProfile'));
		expect(lookups).toHaveLength(2);
		expect(lookups[0]).toContain('actor=nova.bsky.social');
	});

	it('reports a heal that could not complete without claiming the profile is at fault', async () => {
		// The profile resolves fine; the copy to storage is what fails, which is the
		// dominant real-world shape and the reason the wording is about hosting.
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL) =>
				String(input).includes('getProfile')
					? new Response(JSON.stringify({ avatar: BSKY_AVATAR }), { status: 200 })
					: new Response('nope', { status: 500 })
			)
		);
		const { sqlite, env } = strandedEnv();
		const waits: Promise<unknown>[] = [];

		const res = await POST(postEvent(env, { secret: CRON_SECRET, batch: '5', waits }));
		expect(res.status).toBe(200);
		expect((await res.json()) as { ownerAvatar: string }).toMatchObject({ ownerAvatar: 'unresolved' });

		await Promise.all(waits);
		expect(jobRow(sqlite).detail).toBe(
			'refreshed 0/0, 0 remaining, owner avatar not re-hosted this run'
		);
	});

	// A thrown heal must not cost the operator the artist run that already
	// succeeded, nor the heartbeat that reports it — and must not be reported as
	// the run a healthy fork has either, which is what 'skipped' would say.
	it('still returns the artist counts and an ok heartbeat when the heal throws', async () => {
		stubProfileAndImage();
		const { sqlite, env } = strandedEnv();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// The heal's settings write is the last thing it does; make it explode.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(sqlite as any).exec(`
			CREATE TRIGGER no_owner_write BEFORE UPDATE ON site_settings
			WHEN NEW.key = 'adminAvatarUrl'
			BEGIN SELECT RAISE(ABORT, 'settings write failed'); END;`);
		const waits: Promise<unknown>[] = [];

		const res = await POST(postEvent(env, { secret: CRON_SECRET, batch: '5', waits }));

		expect(res.status).toBe(200);
		// 'unresolved', not 'skipped': after a throw the owner IS still on someone
		// else's host, and the console.warn is not on the operator's panel, so
		// leaving the initializer would make this fork's heartbeat byte-identical
		// to a healthy one's.
		expect(await res.json()).toEqual({
			processed: 0,
			refreshed: 0,
			remaining: 0,
			ownerAvatar: 'unresolved'
		});
		expect(warn).toHaveBeenCalled();

		await Promise.all(waits);
		const job = jobRow(sqlite);
		expect(job.status).toBe('ok');
		expect(job.detail).toBe('refreshed 0/0, 0 remaining, owner avatar not re-hosted this run');
		warn.mockRestore();
	});
});
