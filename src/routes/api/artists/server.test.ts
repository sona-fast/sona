import { describe, it, expect, vi, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { artists } from '$lib/server/db/schema';
import { POST } from './+server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE artists (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
		global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
		aliases TEXT, avatar_resolved_at TEXT, ledger_private INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
	);`);
	const d1 = makeD1(sqlite);
	const platform = { env: { DB: d1 } } as unknown as App.Platform;
	return { db: drizzle(d1, { schema }), platform };
}

function post(platform: App.Platform, body: Record<string, unknown>) {
	return POST({
		platform,
		url: new URL('https://sparky.ink/api/artists'),
		request: new Request('https://sparky.ink/api/artists', {
			method: 'POST',
			body: JSON.stringify(body)
		})
	} as never);
}

const GID = 'g-furfoggy';

describe('POST /api/artists — explicit registry import overrides the local copy', () => {
	it('reused: refreshes a linked local artist with the registry fields', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({
			name: 'furfoggy (old)',
			globalId: GID,
			registryVersion: 1,
			avatarUrl: null,
			twitterUrl: 'https://x.com/furfoggy',
			createdAt: '2026-07-01'
		});

		const res = await post(platform, {
			name: 'FurFoggy',
			globalId: GID,
			registryVersion: 3,
			twitter: 'https://x.com/furfoggy',
			instagram: 'https://instagram.com/furfoggy',
			avatarUrl: 'https://pbs.twimg.com/profile_images/1/ff_400x400.jpg'
		});
		expect(((await res.json()) as { status: string }).status).toBe('reused');

		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.name).toBe('FurFoggy');
		expect(row!.avatarUrl).toBe('https://pbs.twimg.com/profile_images/1/ff_400x400.jpg');
		expect(row!.instagramUrl).toContain('instagram.com/furfoggy');
		expect(row!.registryVersion).toBe(3);
		expect(row!.registrySyncedAt).toBeTruthy();
	});

	it('reused: a field the registry lacks never blanks the local value', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({
			name: 'Kept',
			globalId: GID,
			telegramUrl: 'https://t.me/keptlocal',
			avatarUrl: 'https://cdn.example/local.png',
			createdAt: '2026-07-01'
		});

		await post(platform, { name: 'Kept', globalId: GID, registryVersion: 2 });

		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.telegramUrl).toBe('https://t.me/keptlocal'); // registry sent none
		expect(row!.avatarUrl).toBe('https://cdn.example/local.png'); // no registry avatar → kept
	});

	it('reused: a missing/non-finite registryVersion never blanks the local version', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({
			name: 'Versioned',
			globalId: GID,
			registryVersion: 7,
			createdAt: '2026-07-01'
		});

		// A refresh call that omits registryVersion must leave the stored one intact.
		await post(platform, { name: 'Versioned', globalId: GID });

		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.registryVersion).toBe(7);
	});

	it('linked: an unlinked handle-match gets linked AND refreshed', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({
			name: 'furfoggy',
			twitterUrl: 'https://x.com/furfoggy',
			createdAt: '2026-07-01'
		});

		const res = await post(platform, {
			name: 'FurFoggy',
			globalId: GID,
			registryVersion: 5,
			twitter: 'https://x.com/furfoggy',
			avatarUrl: 'https://pbs.twimg.com/profile_images/1/ff_400x400.jpg'
		});
		expect(((await res.json()) as { status: string }).status).toBe('linked');

		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.name).toBe('FurFoggy');
		expect(row!.avatarUrl).toContain('ff_400x400');
		expect(row!.registryVersion).toBe(5);
	});

	it('linked: linking a flagged local artist clears its keep-private flag', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({
			name: 'furfoggy',
			twitterUrl: 'https://x.com/furfoggy',
			ledgerPrivate: true,
			createdAt: '2026-07-01'
		});

		const res = await post(platform, {
			name: 'FurFoggy',
			globalId: GID,
			registryVersion: 5,
			twitter: 'https://x.com/furfoggy'
		});
		expect(((await res.json()) as { status: string }).status).toBe('linked');

		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.ledgerPrivate).toBe(false);
	});

	it('created: no local match still creates a fresh artist', async () => {
		const { db, platform } = makeDb();
		const res = await post(platform, {
			name: 'Brand New',
			globalId: GID,
			registryVersion: 1,
			twitter: 'https://x.com/brandnew'
		});
		expect(((await res.json()) as { status: string }).status).toBe('created');
		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.name).toBe('Brand New');
	});

	it('created: stores a Patreon /cw/ link as the flat patreon.com/<name> form', async () => {
		const { db, platform } = makeDb();
		const res = await post(platform, {
			name: 'Bob',
			globalId: GID,
			registryVersion: 1,
			patreon: 'https://www.patreon.com/cw/Bob_Art'
		});
		expect(((await res.json()) as { status: string }).status).toBe('created');
		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.patreonUrl).toBe('https://www.patreon.com/Bob_Art');
	});
});

// Q26: the "keep private" checkbox on the new-artist dialog. It keeps the
// artist off the registry; their avatar is still looked up (SONA-236).
describe('POST /api/artists — keep private', () => {
	afterEach(() => vi.unstubAllGlobals());

	function stubOfflineFetch() {
		const fetchSpy = vi.fn(() => Promise.reject(new Error('offline')));
		vi.stubGlobal('fetch', fetchSpy);
		return fetchSpy;
	}

	it('stores the flag on a new local artist and still stores their avatar', async () => {
		const { db, platform } = makeDb();
		// The profile answers; the CDN copy stays offline, so the source link is kept.
		const avatar = 'https://cdn.bsky.app/img/avatar/plain/quiet.jpg';
		vi.stubGlobal(
			'fetch',
			vi.fn((input: RequestInfo | URL) =>
				String(input).includes('public.api.bsky.app')
					? Promise.resolve(new Response(JSON.stringify({ avatar })))
					: Promise.reject(new Error('offline'))
			)
		);

		const res = await post(platform, { name: 'Quiet', bluesky: 'quiet.bsky.social', ledgerPrivate: true });
		expect(((await res.json()) as { status: string }).status).toBe('created');

		const row = await db.select().from(artists).where(eq(artists.name, 'Quiet')).get();
		expect(row!.ledgerPrivate).toBe(true);
		expect(row!.avatarUrl).toBe(avatar);
	});

	it('looks up the avatar for a new artist without the flag', async () => {
		const { db, platform } = makeDb();
		const fetchSpy = stubOfflineFetch();

		await post(platform, { name: 'Loud', bluesky: 'loud.bsky.social' });

		const row = await db.select().from(artists).where(eq(artists.name, 'Loud')).get();
		expect(row!.ledgerPrivate).toBe(false);
		expect(fetchSpy).toHaveBeenCalled();
	});

	it('ignores the flag for an artist pulled from the registry, which is already shared', async () => {
		const { db, platform } = makeDb();
		stubOfflineFetch();

		await post(platform, { name: 'Shared', globalId: GID, registryVersion: 1, ledgerPrivate: true });

		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.ledgerPrivate).toBe(false);
	});
});

// The commission form offers "Add this Telegram" only to an artist with no
// Telegram, so a dialog-made artist has to come back saying whether it has one.
// The answer is the stored row's, not what the dialog sent (SONA-236).
describe('POST /api/artists — hasTelegram', () => {
	afterEach(() => vi.unstubAllGlobals());

	async function hasTelegram(res: Response) {
		return ((await res.json()) as { hasTelegram?: unknown }).hasTelegram;
	}

	it('created: true when a valid Telegram was given', async () => {
		const { platform } = makeDb();
		vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
		const res = await post(platform, { name: 'Tg Artist', telegram: 'https://t.me/tgartist' });
		expect(await hasTelegram(res)).toBe(true);
	});

	it('created: false when no Telegram was given', async () => {
		const { platform } = makeDb();
		vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
		const res = await post(platform, { name: 'No Tg' });
		expect(await hasTelegram(res)).toBe(false);
	});

	it('created: false when the typed Telegram is dropped as invalid', async () => {
		const { db, platform } = makeDb();
		vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
		const res = await post(platform, { name: 'Bad Tg', telegram: 'not a handle!' });
		expect(await hasTelegram(res)).toBe(false);
		const row = await db.select().from(artists).where(eq(artists.name, 'Bad Tg')).get();
		expect(row!.telegramUrl).toBeNull();
	});

	it('reused: true from the local Telegram when the registry sends none', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ name: 'Kept', globalId: GID, telegramUrl: 'https://t.me/keptlocal', createdAt: '2026-07-01' });
		const res = await post(platform, { name: 'Kept', globalId: GID, registryVersion: 2 });
		expect(await hasTelegram(res)).toBe(true);
	});

	it('reused: true when the registry copy brings a Telegram', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ name: 'Gains', globalId: GID, createdAt: '2026-07-01' });
		const res = await post(platform, { name: 'Gains', globalId: GID, registryVersion: 2, telegram: 'https://t.me/gains' });
		expect(await hasTelegram(res)).toBe(true);
	});

	it('reused: false when neither side has a Telegram', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ name: 'Bare', globalId: GID, createdAt: '2026-07-01' });
		const res = await post(platform, { name: 'Bare', globalId: GID, registryVersion: 2 });
		expect(await hasTelegram(res)).toBe(false);
	});

	it('linked: true from the local Telegram on the matched artist', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({
			name: 'furfoggy',
			twitterUrl: 'https://x.com/furfoggy',
			telegramUrl: 'https://t.me/furfoggy',
			createdAt: '2026-07-01'
		});
		const res = await post(platform, { name: 'FurFoggy', globalId: GID, registryVersion: 5, twitter: 'https://x.com/furfoggy' });
		expect(((await res.clone().json()) as { status: string }).status).toBe('linked');
		expect(await hasTelegram(res)).toBe(true);
	});

	it('linked: false when the matched artist has no Telegram', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ name: 'furfoggy', twitterUrl: 'https://x.com/furfoggy', createdAt: '2026-07-01' });
		const res = await post(platform, { name: 'FurFoggy', globalId: GID, registryVersion: 5, twitter: 'https://x.com/furfoggy' });
		expect(((await res.clone().json()) as { status: string }).status).toBe('linked');
		expect(await hasTelegram(res)).toBe(false);
	});
});
