import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { artists, siteSettings } from './db/schema';
import { eq } from 'drizzle-orm';
import { pickRefreshedAvatar, syncArtists } from './artist-sync';
import type { SiteSettings } from './settings';

const BSKY_OLD = 'https://cdn.bsky.app/img/avatar/plain/did:a/OLD@jpeg';
const BSKY_NEW = 'https://cdn.bsky.app/img/avatar/plain/did:a/NEW@jpeg';
const SELF_HOSTED = 'https://cdn.example.com/avatars/1.png';

describe('pickRefreshedAvatar', () => {
	it('fills an empty local avatar from the registry', () => {
		expect(pickRefreshedAvatar(null, BSKY_NEW)).toBe(BSKY_NEW);
		expect(pickRefreshedAvatar('', BSKY_NEW)).toBe(BSKY_NEW);
	});

	it('replaces a stale bsky-derived local avatar when the registry differs', () => {
		expect(pickRefreshedAvatar(BSKY_OLD, BSKY_NEW)).toBe(BSKY_NEW);
	});

	it('keeps a hand-set / self-hosted local avatar untouched', () => {
		expect(pickRefreshedAvatar(SELF_HOSTED, BSKY_NEW)).toBe(SELF_HOSTED);
	});

	it('keeps the local avatar when the registry has none (never wipes)', () => {
		expect(pickRefreshedAvatar(BSKY_OLD, null)).toBe(BSKY_OLD);
	});

	it('is a no-op when the bsky avatar is already current', () => {
		expect(pickRefreshedAvatar(BSKY_NEW, BSKY_NEW)).toBe(BSKY_NEW);
	});
});

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
	return drizzle(makeD1(sqlite), { schema });
}

const ENV = { REGISTRY_API_KEY: 'test-key' } as unknown as App.Platform['env'];
// syncArtists only reads registryOverridesLocal, and only inside the delta-refresh
// loop (which our empty delta feed never enters). The rest is irrelevant here.
const SETTINGS = { registryOverridesLocal: false } as unknown as SiteSettings;

// Route registry HTTP: the delta feed (job 1) returns empty so only the backfill
// runs; the handle search returns whatever candidate the test supplies.
function stubRegistry(searchArtists: unknown[]) {
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			const body = url.includes('/v1/artists/search')
				? { artists: searchArtists }
				: { artists: [], nextCursor: null };
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			);
		})
	);
}

// Route the delta feed to a single canned response (status + body) so the client's
// refusal/fail-soft split is exercised for real; the handle search stays healthy so
// a failure can only come from the delta feed.
function stubDeltaResponse(status: number, body: unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) =>
			Promise.resolve(
				url.includes('/v1/artists/search')
					? new Response(JSON.stringify({ artists: [] }), { status: 200 })
					: new Response(JSON.stringify(body), {
							status,
							headers: { 'content-type': 'application/json' }
						})
			)
		)
	);
}

// Route the delta feed page by page: `pages` is a list of [status, body] pairs served
// in request order, so a LATER page can fail after an earlier one already succeeded
// (the single-response stub above can't express that). The handle search stays healthy
// — it's a different, unauthenticated endpoint — so the backfill can be observed.
function stubDeltaPages(pages: [number, unknown][], searchArtists: unknown[] = []) {
	let page = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			const headers = { 'content-type': 'application/json' };
			if (String(url).includes('/v1/artists/search'))
				return Promise.resolve(
					new Response(JSON.stringify({ artists: searchArtists }), { status: 200, headers })
				);
			const [status, body] = pages[Math.min(page++, pages.length - 1)];
			return Promise.resolve(new Response(JSON.stringify(body), { status, headers }));
		})
	);
}

/** A registry delta record for a linked local row. */
function deltaArtist(globalId: string, version: number, updatedAt: string) {
	return {
		globalId,
		displayName: globalId,
		avatarUrl: null,
		bio: null,
		socials: {},
		status: 'active' as const,
		mergedInto: null,
		version,
		updatedAt
	};
}

function searchCalls() {
	return vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/v1/artists/search'));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('syncArtists delta feed — authentication', () => {
	it('sends the fork key as a bearer token on the delta request', async () => {
		const db = makeDb();
		stubDeltaResponse(200, { artists: [], nextCursor: null });

		await syncArtists(db, ENV, SETTINGS);

		const fetchMock = vi.mocked(fetch);
		const deltaCall = fetchMock.mock.calls.find(([url]) =>
			String(url).includes('/v1/artists?')
		);
		expect(deltaCall).toBeDefined();
		const init = deltaCall![1] as RequestInit;
		expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
	});

	// The whole point of the change: a 401 must NOT come back as a successful sync of
	// zero artists (the pre-fix behaviour), because that is indistinguishable from
	// "no new artists" and would silently stop imports forever.
	it('throws on a 401 refusal instead of reporting a zero-artist success', async () => {
		const db = makeDb();
		stubDeltaResponse(401, { error: 'invalid fork key' });

		await expect(syncArtists(db, ENV, SETTINGS)).rejects.toThrow(/401.*invalid fork key/);
	});

	it('throws on a 403 refusal too, naming the status and the registry reason', async () => {
		const db = makeDb();
		stubDeltaResponse(403, { error: 'fork key revoked' });

		await expect(syncArtists(db, ENV, SETTINGS)).rejects.toThrow(/403.*fork key revoked/);
	});

	// A transient outage must stay soft: turning it into a hard cron failure would
	// page us for every registry blip.
	it('still fails soft on a 5xx (no throw, empty delta, backfill continues)', async () => {
		const db = makeDb();
		const now = new Date().toISOString();
		await db
			.insert(artists)
			.values({ name: 'mlyeko', twitterUrl: 'https://twitter.com/mlyeko', createdAt: now });
		stubDeltaResponse(503, { error: 'registry down' });

		const summary = await syncArtists(db, ENV, SETTINGS);
		expect(summary).toMatchObject({ refreshed: 0, scanned: 1 });
	});

	it('still fails soft when the delta request rejects (network error)', async () => {
		const db = makeDb();
		vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));

		const summary = await syncArtists(db, ENV, SETTINGS);
		expect(summary).toMatchObject({ refreshed: 0, linked: 0 });
	});

	// Only 401/403 is fatal. The registry's read limiter answers 429 with a JSON error
	// body, and cron subrequests carry no eyeball IP, so every fork shares one bucket —
	// a rate-limit is transient and self-correcting. Failing the whole run for it turns
	// a no-op into a failed job (and an "Import all" that imports nothing).
	it.each([
		[429, 'rate limited — slow down'],
		[408, 'request timeout']
	])('does NOT throw on a transient %i refusal (fails soft, backfill still runs)', async (status, reason) => {
		const db = makeDb();
		const now = new Date().toISOString();
		await db
			.insert(artists)
			.values({ name: 'mlyeko', twitterUrl: 'https://twitter.com/mlyeko', createdAt: now });
		stubDeltaResponse(status, { error: reason });

		const summary = await syncArtists(db, ENV, SETTINGS);
		expect(summary).toMatchObject({ refreshed: 0, scanned: 1 });
	});

	// The reachable-today shape: page 1 fine, page 2 rate-limited. The run resolves and
	// keeps page 1 — previously it 500'd the cron endpoint and recorded a failed job.
	it('resolves and keeps page 1 when page 2 is rate-limited (429)', async () => {
		const db = makeDb();
		const now = new Date().toISOString();
		await db.insert(artists).values({ name: 'mlyeko', globalId: 'g-mlyeko', createdAt: now });
		await db
			.insert(artists)
			.values({ name: 'Nyx', twitterUrl: 'https://twitter.com/nyx', createdAt: now });
		stubDeltaPages([
			[200, { artists: [deltaArtist('g-mlyeko', 7, now)], nextCursor: 'c1' }],
			[429, { error: 'rate limited — slow down' }]
		]);

		const summary = await syncArtists(db, ENV, SETTINGS);
		expect(summary).toMatchObject({ refreshed: 1, scanned: 1 });
		const lastSync = await db
			.select()
			.from(siteSettings)
			.where(eq(siteSettings.key, 'registryLastSync'))
			.get();
		expect(lastSync?.value).toBe(now);
		expect(searchCalls()).toHaveLength(1);
	});

	// A refusal on page 2 must not discard page 1: throwing inside the paging loop
	// skipped the cursor write AND the (healthy, unauthenticated) backfill, so every run
	// re-walked the same pages and no unlinked artist ever got linked.
	it('keeps the pages that succeeded when a later page is refused (cursor + backfill still run)', async () => {
		const db = makeDb();
		const now = new Date().toISOString();
		await db.insert(artists).values({ name: 'mlyeko', globalId: 'g-mlyeko', createdAt: now });
		// Unlinked, with a handle — the backfill must reach it despite the refusal.
		await db
			.insert(artists)
			.values({ name: 'Nyx', twitterUrl: 'https://twitter.com/nyx', createdAt: now });
		stubDeltaPages([
			[200, { artists: [deltaArtist('g-mlyeko', 7, now)], nextCursor: 'c1' }],
			[401, { error: 'invalid fork key' }]
		]);

		// Fail-loud is preserved: a 401 is fatal, so the run still reports failure…
		await expect(syncArtists(db, ENV, SETTINGS)).rejects.toThrow(/401.*invalid fork key/);

		// …but only after page 1's work persisted.
		const row = await db.select().from(artists).where(eq(artists.globalId, 'g-mlyeko')).get();
		expect(row?.registryVersion).toBe(7);
		// The sync cursor advanced, so the next run resumes instead of re-walking page 1.
		const lastSync = await db
			.select()
			.from(siteSettings)
			.where(eq(siteSettings.key, 'registryLastSync'))
			.get();
		expect(lastSync?.value).toBe(now);
		// And the backfill ran: the handle search was called for the unlinked artist.
		expect(searchCalls()).toHaveLength(1);
	});

	it('refreshes linked artists as before when the key works', async () => {
		const db = makeDb();
		const now = new Date().toISOString();
		await db
			.insert(artists)
			.values({ name: 'mlyeko', globalId: 'g-mlyeko', createdAt: now });
		stubDeltaResponse(200, {
			artists: [
				{
					globalId: 'g-mlyeko',
					displayName: 'mlyeko',
					avatarUrl: BSKY_NEW,
					bio: null,
					socials: {},
					status: 'active',
					mergedInto: null,
					version: 9,
					updatedAt: now
				}
			],
			nextCursor: null
		});

		const summary = await syncArtists(db, ENV, SETTINGS);
		expect(summary.refreshed).toBe(1);
		const row = await db.select().from(artists).where(eq(artists.globalId, 'g-mlyeko')).get();
		expect(row?.registryVersion).toBe(9);
		expect(row?.avatarUrl).toBe(BSKY_NEW);
	});
});

describe('syncArtists backfill — identity verification', () => {
	const now = new Date().toISOString();

	it('does NOT stamp when the only overlap is a same-string handle on a DIFFERENT platform', async () => {
		const db = makeDb();
		await db
			.insert(artists)
			.values({ name: 'mlyeko', twitterUrl: 'https://twitter.com/mlyeko', createdAt: now });

		// The registry-collision shape: "Buttsteak" has a Twitter URL pasted into its
		// Instagram field, indexed as instagram handle "twitter.com" — it shares the
		// string "twitter.com" with the local artist's URL but no same-platform handle.
		stubRegistry([
			{
				globalId: 'g-buttsteak',
				displayName: 'Buttsteak',
				avatarUrl: null,
				bio: null,
				socials: { instagramUrl: 'https://twitter.com/buttsteak' },
				status: 'active',
				mergedInto: null,
				version: 3,
				updatedAt: now
			}
		]);

		const summary = await syncArtists(db, ENV, SETTINGS);
		expect(summary.linked).toBe(0);
		const row = await db.select().from(artists).where(eq(artists.name, 'mlyeko')).get();
		expect(row?.globalId).toBeNull();
	});

	it('stamps when a candidate shares the same handle on the SAME platform', async () => {
		const db = makeDb();
		await db
			.insert(artists)
			.values({ name: 'mlyeko', twitterUrl: 'https://twitter.com/mlyeko', createdAt: now });

		stubRegistry([
			{
				globalId: 'g-mlyeko',
				displayName: 'mlyeko',
				avatarUrl: null,
				bio: null,
				// x.com vs twitter.com must still match after normalization.
				socials: { twitterUrl: 'https://x.com/mlyeko' },
				status: 'active',
				mergedInto: null,
				version: 7,
				updatedAt: now
			}
		]);

		const summary = await syncArtists(db, ENV, SETTINGS);
		expect(summary.linked).toBe(1);
		const row = await db.select().from(artists).where(eq(artists.name, 'mlyeko')).get();
		expect(row?.globalId).toBe('g-mlyeko');
		expect(row?.registryVersion).toBe(7);
	});

	it('leaves the artist unlinked when the search returns no candidates', async () => {
		const db = makeDb();
		await db
			.insert(artists)
			.values({ name: 'mlyeko', twitterUrl: 'https://twitter.com/mlyeko', createdAt: now });

		stubRegistry([]);

		const summary = await syncArtists(db, ENV, SETTINGS);
		expect(summary.linked).toBe(0);
		const row = await db.select().from(artists).where(eq(artists.name, 'mlyeko')).get();
		expect(row?.globalId).toBeNull();
	});
});
