import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { artists } from './db/schema';
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

afterEach(() => {
	vi.unstubAllGlobals();
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
