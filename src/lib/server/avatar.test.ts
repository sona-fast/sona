import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { artists } from './db/schema';
import { makeD1 } from './test/d1';
import {
	resolveAvatarUrl,
	refreshArtistAvatars,
	isOurAvatarUrl,
	shouldWriteAvatar,
	type AvatarRehostContext,
	healOwnerAvatar
} from './avatar';
import type { SiteSettings } from './settings';
import { getRawSetting, getSettings, setRawSetting, clearSettingsCache } from './settings';

const DDL = `
CREATE TABLE artists (
	id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
	bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT,
	patreon_url TEXT, instagram_url TEXT, global_id TEXT, registry_version INTEGER,
	registry_synced_at TEXT, aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(DDL);
	const db = drizzle(makeD1(sqlite), { schema });
	return { db, sqlite };
}

// A fake R2 bucket: put/list/delete all succeed without touching the network.
function fakeBucket() {
	return {
		put: vi.fn(async (_key: string, _body?: unknown, _opts?: unknown) => {}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({ objects: [], truncated: false }))
	};
}

// getStorage('r2') needs env.IMAGES + a public base; cdn.test makes stored URLs owned.
function r2Ctx(bucket: ReturnType<typeof fakeBucket>, keyHint = 'nova'): AvatarRehostContext {
	return {
		env: { IMAGES: bucket } as unknown as App.Platform['env'],
		settings: { storageProvider: 'r2', r2PublicUrl: 'https://cdn.test' } as unknown as SiteSettings,
		origin: 'https://site.test',
		keyHint
	};
}

const BSKY_AVATAR = 'https://cdn.bsky.app/img/avatar/plain/did/abc@jpeg';

/**
 * Route fetch by URL: the Bluesky getProfile lookup returns a profile with an
 * avatar, and the avatar download returns image bytes. `override` lets a test
 * change the download response (non-2xx, wrong content-type, or no profile).
 */
function stubFetch(override?: {
	profile?: { avatar?: string } | null;
	imageStatus?: number;
	imageType?: string;
}) {
	// `init` is unused by the routing but captured so a test can assert the request
	// options (the redirect posture is only observable there).
	const fetchMock = vi.fn(async (input: string | URL, _init?: RequestInit) => {
		const url = String(input);
		if (url.includes('getProfile')) {
			const profile = override?.profile === undefined ? { avatar: BSKY_AVATAR } : override.profile;
			if (!profile) return new Response('not found', { status: 404 });
			return new Response(JSON.stringify(profile), { status: 200 });
		}
		// The avatar image download.
		const status = override?.imageStatus ?? 200;
		const type = override?.imageType ?? 'image/jpeg';
		return new Response(new Uint8Array([1, 2, 3, 4]), { status, headers: { 'content-type': type } });
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('resolveAvatarUrl re-hosting', () => {
	beforeEach(() => stubFetch());

	it('downloads the resolved avatar and stores it on our own CDN', async () => {
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(bucket));
		// Stored, not hotlinked: our key scheme, and the source URL is gone.
		expect(bucket.put).toHaveBeenCalledTimes(1);
		expect(bucket.put.mock.calls[0][0]).toMatch(/^avatars\/nova\/[0-9a-f-]+\.jpg$/);
		expect(url).toContain('/avatars/nova/');
		expect(url).not.toBe(BSKY_AVATAR);
	});

	it('falls back to the source URL when the download fails (fail-soft)', async () => {
		stubFetch({ imageStatus: 500 });
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(bucket));
		expect(bucket.put).not.toHaveBeenCalled();
		expect(url).toBe(BSKY_AVATAR);
	});

	it('refuses a non-raster content-type and keeps the source URL', async () => {
		stubFetch({ imageType: 'text/html' });
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(bucket));
		expect(bucket.put).not.toHaveBeenCalled();
		expect(url).toBe(BSKY_AVATAR);
	});

	it('returns the raw source URL when no re-host context is given', async () => {
		const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' });
		expect(url).toBe(BSKY_AVATAR);
	});

	// Same outbound posture as the byte proxy: the URL comes from a profile
	// response rather than from a caller, but this fetch now runs unattended on a
	// daily schedule, so a profile pointing at an internal host must not be
	// downloaded at all — refused BEFORE the request, not after.
	it('refuses to download an avatar hosted on a private address', async () => {
		const fetchMock = stubFetch({ profile: { avatar: 'http://127.0.0.1:8080/x.jpg' } });
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(bucket));
		// Only the profile lookup went out — the download never happened.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(bucket.put).not.toHaveBeenCalled();
		expect(url).toBe('http://127.0.0.1:8080/x.jpg');
	});

	it('does not follow redirects on the avatar download', async () => {
		const fetchMock = stubFetch();
		await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(fakeBucket()));
		// A storage/CDN host answering 3xx is an upstream error, not an invitation
		// to fetch wherever it points. Asserted on the request because 'manual' is
		// only observable there.
		expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'manual' });
	});
});

describe('isOurAvatarUrl', () => {
	const env = { IMAGES: fakeBucket() } as unknown as App.Platform['env'];
	// No r2PublicUrl → the R2 base is root-relative '/img' (the no-CDN fork case).
	const noCdn = { storageProvider: 'r2' } as unknown as SiteSettings;
	const withCdn = { storageProvider: 'r2', r2PublicUrl: 'https://cdn.test' } as unknown as SiteSettings;
	const origin = 'https://fork.test';

	it('accepts a URL owned by the configured CDN base', () => {
		expect(isOurAvatarUrl(env, withCdn, origin, 'https://cdn.test/avatars/a/x.jpg')).toBe(true);
	});

	it('accepts a root-relative URL', () => {
		expect(isOurAvatarUrl(env, noCdn, origin, '/img/avatars/a/x.jpg')).toBe(true);
	});

	it('accepts a same-origin absolute URL whose path would be owned (no-CDN absolutized)', () => {
		expect(isOurAvatarUrl(env, noCdn, origin, 'https://fork.test/img/avatars/a/x.jpg')).toBe(true);
	});

	it('rejects a foreign hotlink', () => {
		expect(isOurAvatarUrl(env, noCdn, origin, 'https://pbs.twimg.com/a_400x400.jpg')).toBe(false);
	});

	it('rejects a different-origin URL even with an owned-looking path (SSRF rationale)', () => {
		expect(isOurAvatarUrl(env, noCdn, origin, 'https://evil.test/img/avatars/a/x.jpg')).toBe(false);
	});

	it('rejects a protocol-relative URL (different origin, not root-relative)', () => {
		expect(isOurAvatarUrl(env, noCdn, origin, '//evil.test/img/avatars/a/x.jpg')).toBe(false);
	});

	// The configured Site URL is a known-self origin: an avatar absolutized under
	// the canonical host must stay ours when the request arrives on another host.
	const noCdnWithSiteUrl = {
		storageProvider: 'r2',
		siteUrl: 'https://taro.surf'
	} as unknown as SiteSettings;

	it('accepts an absolute URL on the configured Site URL origin from another request host', () => {
		expect(
			isOurAvatarUrl(env, noCdnWithSiteUrl, 'https://preview.pages.dev', 'https://taro.surf/img/avatars/a/x.jpg')
		).toBe(true);
	});

	it('still rejects a foreign origin when a Site URL is configured (exact-origin equality)', () => {
		expect(
			isOurAvatarUrl(env, noCdnWithSiteUrl, 'https://preview.pages.dev', 'https://evil.test/img/avatars/a/x.jpg')
		).toBe(false);
	});
});

describe('shouldWriteAvatar (shared write gate)', () => {
	const env = { IMAGES: fakeBucket() } as unknown as App.Platform['env'];
	const settings = { storageProvider: 'r2', r2PublicUrl: 'https://cdn.test' } as unknown as SiteSettings;
	const origin = 'https://site.test';
	const gate = (currentUrl: string | null, resolved: string | null) =>
		shouldWriteAvatar(env, settings, origin, currentUrl, resolved);

	it('never writes a null resolve (transient failure keeps whatever is stored)', () => {
		expect(gate(null, null)).toBe(false);
		expect(gate('https://cdn.test/avatars/a/x.jpg', null)).toBe(false);
	});

	it('writes an owned resolve over anything', () => {
		expect(gate(null, 'https://cdn.test/avatars/a/new.jpg')).toBe(true);
		expect(gate('https://cdn.test/avatars/a/old.jpg', 'https://cdn.test/avatars/a/new.jpg')).toBe(true);
		expect(gate('https://pbs.twimg.com/a_400x400.jpg', 'https://cdn.test/avatars/a/new.jpg')).toBe(true);
	});

	it('writes a hotlink fallback only where there is no owned avatar to lose', () => {
		expect(gate(null, BSKY_AVATAR)).toBe(true); // hotlink beats nothing
		expect(gate('https://pbs.twimg.com/stale_400x400.jpg', BSKY_AVATAR)).toBe(true); // fresh beats stale
		expect(gate('https://cdn.test/avatars/a/x.jpg', BSKY_AVATAR)).toBe(false); // never downgrade
	});
});

describe('refreshArtistAvatars', () => {
	beforeEach(() => stubFetch());

	it("mode 'rotted' only touches null/hotlinked avatars, bounded by limit", async () => {
		const { db } = makeDb();
		await db.insert(artists).values([
			{ name: 'Hotlinked', blueskyUrl: 'a.bsky.social', avatarUrl: 'https://pbs.twimg.com/x_400x400.jpg', createdAt: 'x' },
			{ name: 'Owned', blueskyUrl: 'b.bsky.social', avatarUrl: 'https://cdn.test/avatars/b/old.jpg', createdAt: 'x' },
			{ name: 'Missing', blueskyUrl: 'c.bsky.social', avatarUrl: null, createdAt: 'x' },
			{ name: 'NoSocial', avatarUrl: null, createdAt: 'x' }
		]);
		const bucket = fakeBucket();
		const r = await refreshArtistAvatars(db, {
			env: { IMAGES: bucket } as unknown as App.Platform['env'],
			settings: { storageProvider: 'r2', r2PublicUrl: 'https://cdn.test' } as unknown as SiteSettings,
			origin: 'https://site.test',
			limit: 1,
			mode: 'rotted'
		});
		// Candidates are Hotlinked + Missing (Owned is self-hosted, NoSocial unresolvable).
		expect(r).toEqual({ processed: 1, refreshed: 1, remaining: 1 });

		const owned = await db.select().from(artists).where(eq(artists.name, 'Owned')).get();
		expect(owned!.avatarUrl).toBe('https://cdn.test/avatars/b/old.jpg'); // untouched
		expect(owned!.avatarResolvedAt).toBeNull();
	});

	it("mode 'rotted' on a no-CDN fork skips its own absolutized avatars (no re-host churn)", async () => {
		const { db } = makeDb();
		await db.insert(artists).values([
			// Stored by a previous re-host on a fork with no CDN: '/img/…' absolutized
			// against the request origin. owns() alone calls this foreign (SSRF guard).
			{ name: 'SelfHosted', blueskyUrl: 's.bsky.social', avatarUrl: 'https://fork.test/img/avatars/s/x.jpg', createdAt: 'x' },
			{ name: 'Hotlinked', blueskyUrl: 'h.bsky.social', avatarUrl: 'https://pbs.twimg.com/h_400x400.jpg', createdAt: 'x' }
		]);
		const bucket = fakeBucket();
		const r = await refreshArtistAvatars(db, {
			env: { IMAGES: bucket } as unknown as App.Platform['env'],
			settings: { storageProvider: 'r2' } as unknown as SiteSettings, // no r2PublicUrl
			origin: 'https://fork.test',
			limit: 10,
			mode: 'rotted'
		});
		// Only Hotlinked is a candidate — SelfHosted is ours despite failing owns().
		expect(r).toEqual({ processed: 1, refreshed: 1, remaining: 0 });
		const self = await db.select().from(artists).where(eq(artists.name, 'SelfHosted')).get();
		expect(self!.avatarUrl).toBe('https://fork.test/img/avatars/s/x.jpg'); // untouched
		expect(self!.avatarResolvedAt).toBeNull();
	});

	it('never downgrades an owned avatar to the source-hotlink fallback, but still stamps', async () => {
		stubFetch({ imageStatus: 500 }); // rehost fails → resolveAvatarUrl returns the SOURCE hotlink
		const { db } = makeDb();
		await db.insert(artists).values([
			{ name: 'Owned', blueskyUrl: 'o.bsky.social', avatarUrl: 'https://cdn.test/avatars/o/x.jpg', createdAt: 'x' },
			{ name: 'Bare', blueskyUrl: 'b.bsky.social', avatarUrl: null, createdAt: 'x' },
			{ name: 'Stale', blueskyUrl: 's.bsky.social', avatarUrl: 'https://pbs.twimg.com/old_400x400.jpg', createdAt: 'x' }
		]);
		const bucket = fakeBucket();
		const r = await refreshArtistAvatars(db, {
			env: { IMAGES: bucket } as unknown as App.Platform['env'],
			settings: { storageProvider: 'r2', r2PublicUrl: 'https://cdn.test' } as unknown as SiteSettings,
			origin: 'https://site.test',
			limit: 10,
			mode: 'oldest'
		});
		// The hotlink is written only where there's no owned avatar to lose.
		expect(r).toEqual({ processed: 3, refreshed: 2, remaining: 0 });
		const owned = await db.select().from(artists).where(eq(artists.name, 'Owned')).get();
		expect(owned!.avatarUrl).toBe('https://cdn.test/avatars/o/x.jpg'); // not downgraded
		expect(owned!.avatarResolvedAt).toBeTruthy(); // stamped anyway (starvation guard)
		const bare = await db.select().from(artists).where(eq(artists.name, 'Bare')).get();
		expect(bare!.avatarUrl).toBe(BSKY_AVATAR); // hotlink beats nothing
		expect(bare!.avatarResolvedAt).toBeTruthy();
		const stale = await db.select().from(artists).where(eq(artists.name, 'Stale')).get();
		expect(stale!.avatarUrl).toBe(BSKY_AVATAR); // fresh hotlink beats a stale one
	});

	it('keeps the existing avatar when re-resolution fails, but still stamps (clobber guard)', async () => {
		stubFetch({ profile: null }); // getProfile 404 → resolveAvatarUrl returns null
		const { db } = makeDb();
		await db.insert(artists).values({
			name: 'Rotted',
			blueskyUrl: 'r.bsky.social',
			avatarUrl: 'https://pbs.twimg.com/keep_400x400.jpg',
			createdAt: 'x'
		});
		const bucket = fakeBucket();
		const r = await refreshArtistAvatars(db, {
			env: { IMAGES: bucket } as unknown as App.Platform['env'],
			settings: { storageProvider: 'r2', r2PublicUrl: 'https://cdn.test' } as unknown as SiteSettings,
			origin: 'https://site.test',
			limit: 10,
			mode: 'rotted'
		});
		expect(r).toEqual({ processed: 1, refreshed: 0, remaining: 0 });
		const row = await db.select().from(artists).where(eq(artists.name, 'Rotted')).get();
		expect(row!.avatarUrl).toBe('https://pbs.twimg.com/keep_400x400.jpg'); // not clobbered to null
		expect(row!.avatarResolvedAt).toBeTruthy(); // stamped so it can't starve the rotation
	});

	it("mode 'oldest' rotates oldest-first (nulls first) and leaves the rest for next run", async () => {
		const { db } = makeDb();
		await db.insert(artists).values([
			{ name: 'Newest', blueskyUrl: 'n.bsky.social', avatarUrl: 'https://cdn.test/avatars/n/x.jpg', avatarResolvedAt: '2026-06-01T00:00:00Z', createdAt: 'x' },
			{ name: 'Never', blueskyUrl: 'z.bsky.social', avatarUrl: 'https://cdn.test/avatars/z/x.jpg', avatarResolvedAt: null, createdAt: 'x' },
			{ name: 'Old', blueskyUrl: 'o.bsky.social', avatarUrl: 'https://cdn.test/avatars/o/x.jpg', avatarResolvedAt: '2026-01-01T00:00:00Z', createdAt: 'x' }
		]);
		const bucket = fakeBucket();
		const r = await refreshArtistAvatars(db, {
			env: { IMAGES: bucket } as unknown as App.Platform['env'],
			settings: { storageProvider: 'r2', r2PublicUrl: 'https://cdn.test' } as unknown as SiteSettings,
			origin: 'https://site.test',
			limit: 2,
			mode: 'oldest'
		});
		expect(r).toEqual({ processed: 2, refreshed: 2, remaining: 1 });
		// Newest was skipped this run — its timestamp is unchanged.
		const newest = await db.select().from(artists).where(eq(artists.name, 'Newest')).get();
		expect(newest!.avatarResolvedAt).toBe('2026-06-01T00:00:00Z');
	});
});

describe('healOwnerAvatar (the retry nothing used to do)', () => {
	beforeEach(() => {
		stubFetch();
		// getSettings memoizes at module scope for 60s and the cache is shared by
		// every test in this file, so a stale entry from an earlier test would
		// otherwise answer here.
		clearSettingsCache();
	});
	afterEach(() => vi.restoreAllMocks());

	const OWNER_HANDLE = 'https://bsky.app/profile/nova.bsky.social';

	/**
	 * Seed the two OWNER rows. These live in D1 rather than in the settings
	 * snapshot on purpose (see healOwnerAvatar): the cron captures settings once
	 * and the operator can save the site tab before the heal runs, so the rows are
	 * the only trustworthy source for what to resolve and what not to overwrite.
	 */
	async function seedOwner(
		db: ReturnType<typeof makeDb>['db'],
		row: { blueskyUrl?: string; adminAvatarUrl?: string } = {}
	) {
		const values = { blueskyUrl: OWNER_HANDLE, adminAvatarUrl: BSKY_AVATAR, ...row };
		for (const [key, value] of Object.entries(values)) await setRawSetting(db, key, value);
	}

	// Storage config only. The owner fields are deliberately set to values the
	// function must IGNORE, so a test that passes proves it read D1.
	const ownerSettings = (over: Partial<SiteSettings> = {}) =>
		({
			storageProvider: 'r2',
			r2PublicUrl: 'https://cdn.test',
			blueskyUrl: 'https://bsky.app/profile/stale.bsky.social',
			adminAvatarUrl: 'https://cdn.test/avatars/owner/stale.jpg',
			...over
		}) as unknown as SiteSettings;

	const opts = (
		bucket: ReturnType<typeof fakeBucket>,
		settings: SiteSettings,
		origin = 'https://site.test'
	) => ({
		env: { IMAGES: bucket } as unknown as App.Platform['env'],
		settings,
		origin
	});

	it('re-hosts a stranded hotlink and stores the copy we serve', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db);

		const res = await healOwnerAvatar(db, opts(bucket, ownerSettings()));

		expect(res).toBe('healed');
		// Under the owner's own folder — 'owner' silently becoming '' would still
		// store SOMETHING, so pin the key, not just that a put happened.
		expect(bucket.put.mock.calls[0][0]).toMatch(/^avatars\/owner\/[0-9a-f-]+\.jpg$/);
		const stored = await getRawSetting(db, 'adminAvatarUrl');
		expect(stored).toMatch(/^https:\/\/cdn\.test\/avatars\/owner\//);
	});

	it('leaves an avatar we already serve alone, without a profile lookup', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		const owned = 'https://cdn.test/avatars/owner/face.jpg';
		await seedOwner(db, { adminAvatarUrl: owned });

		const res = await healOwnerAvatar(db, opts(bucket, ownerSettings()));

		// Heal-only: a healthy fork must not pay for a fetch every single run.
		expect(res).toBe('skipped');
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe(owned);
	});

	it('does not write another hotlink over the one already there', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db);
		// Re-hosting fails, so resolveAvatarUrl falls back to the SOURCE hotlink.
		stubFetch({ imageStatus: 500 });

		const res = await healOwnerAvatar(db, opts(bucket, ownerSettings()));

		// Reported honestly as still broken, and the row is left holding what it
		// held rather than churned with an equivalent bad value.
		expect(res).toBe('unresolved');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe(BSKY_AVATAR);
	});

	// The profile lookup 404s → resolveAvatarUrl returns null. Without the null
	// check ahead of it, isOurAvatarUrl(null) throws a TypeError straight into the
	// cron's swallowing catch, where nothing would ever report it.
	it('reports a failed profile lookup instead of throwing on the null', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db);
		stubFetch({ profile: null });

		const res = await healOwnerAvatar(db, opts(bucket, ownerSettings()));

		expect(res).toBe('unresolved');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe(BSKY_AVATAR);
	});

	it('does nothing when the owner has no bluesky handle to resolve from', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db, { blueskyUrl: '' });

		const res = await healOwnerAvatar(db, opts(bucket, ownerSettings()));

		expect(res).toBe('skipped');
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	// The isolate that repaired the row must stop serving the value it replaced.
	// SETTINGS_TTL_MS is 60s, so a heal that left the cache warm would keep the
	// hotlink on the page for a minute after it was fixed.
	it('leaves the settings cache holding the healed URL, not the hotlink it replaced', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db);
		// Prime it: this is the read the request that triggered the run already did.
		expect((await getSettings(db)).adminAvatarUrl).toBe(BSKY_AVATAR);

		expect(await healOwnerAvatar(db, opts(bucket, ownerSettings()))).toBe('healed');

		expect((await getSettings(db)).adminAvatarUrl).toMatch(/^https:\/\/cdn\.test\/avatars\/owner\//);
	});

	// The snapshot the cron captured is minutes old by the time the heal runs, and
	// a site-tab save in between is reachable by hand (the workflow has a
	// workflow_dispatch). These three pin that D1 — not the snapshot — decides.
	it('skips when the operator cleared their bluesky field after the snapshot was taken', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		// saveSite pairs the two: clearing bluesky clears the derived avatar with it.
		await seedOwner(db, { blueskyUrl: '', adminAvatarUrl: '' });

		// The snapshot still carries a handle and a hotlink: the stale view says heal.
		const stale = ownerSettings({ blueskyUrl: OWNER_HANDLE, adminAvatarUrl: BSKY_AVATAR });
		const res = await healOwnerAvatar(db, opts(bucket, stale));

		// Resurrecting an avatar the operator deliberately cleared is exactly the
		// thing the fresh read prevents.
		expect(res).toBe('skipped');
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('');
	});

	it('skips when the operator saved a good avatar after the snapshot was taken', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		const justSaved = 'https://cdn.test/avatars/owner/just-saved.jpg';
		await seedOwner(db, { adminAvatarUrl: justSaved });

		const res = await healOwnerAvatar(db, opts(bucket, ownerSettings()));

		expect(res).toBe('skipped');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe(justSaved);
	});

	it('resolves against the handle stored in D1, not the one in the stale snapshot', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db, { blueskyUrl: 'https://bsky.app/profile/current.bsky.social' });

		expect(await healOwnerAvatar(db, opts(bucket, ownerSettings()))).toBe('healed');

		const lookup = String(vi.mocked(globalThis.fetch).mock.calls[0][0]);
		expect(lookup).toContain('actor=current.bsky.social');
		expect(lookup).not.toContain('stale.bsky.social');
	});

	// The resolve itself takes seconds on the network, so the handle can change
	// under it too. The copy is then of an account that is no longer the owner's,
	// and writing it would put the OLD face on the new handle — and because that
	// value is one of ours, every later run would skip and the error would stick.
	it('drops the re-hosted copy when the handle changes during the resolve', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL) => {
				if (String(input).includes('getProfile')) {
					return new Response(JSON.stringify({ avatar: BSKY_AVATAR }), { status: 200 });
				}
				// The operator's save lands while the avatar bytes are downloading.
				await setRawSetting(db, 'blueskyUrl', 'https://bsky.app/profile/moved.bsky.social');
				return new Response(new Uint8Array([1, 2, 3, 4]), {
					status: 200,
					headers: { 'content-type': 'image/jpeg' }
				});
			})
		);

		const res = await healOwnerAvatar(db, opts(bucket, ownerSettings()));

		expect(res).toBe('unresolved');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe(BSKY_AVATAR);
	});

	// A machine endpoint behind a shared secret must not take its site identity
	// from the caller's Host header: with no CDN configured the stored URL is
	// absolutized against whatever origin it is handed, and isOurAvatarUrl would
	// then accept the result, so the request origin would persist site-wide.
	it('absolutizes against the configured Site URL, not the requesting host', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db);
		// No r2PublicUrl → the R2 base is root-relative '/img' (the no-CDN fork).
		const settings = ownerSettings({ r2PublicUrl: '', siteUrl: 'https://taro.surf' });

		const res = await healOwnerAvatar(db, opts(bucket, settings, 'https://preview.pages.dev'));

		expect(res).toBe('healed');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toMatch(
			/^https:\/\/taro\.surf\/img\/avatars\/owner\//
		);
	});
});
