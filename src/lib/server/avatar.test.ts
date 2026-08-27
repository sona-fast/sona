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
	healOwnerAvatar,
	MAX_AVATAR_BYTES
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
/** Where a 3xx download points. Serving real bytes here makes following observable. */
const REDIRECT_TARGET = 'https://redirected.test/x.jpg';

/**
 * Route fetch by URL: the Bluesky getProfile lookup returns a profile with an
 * avatar, and the avatar download returns image bytes. `override` lets a test
 * change the download response (non-2xx, wrong content-type, or no profile).
 *
 * A 3xx `imageStatus` is modelled the way a real fetch treats one: followed to
 * REDIRECT_TARGET unless the caller asked for redirect:'manual'. That is what
 * lets a test pin the redirect posture by what gets stored rather than by
 * asserting the request options back at the platform.
 */
function stubFetch(override?: {
	profile?: { avatar?: string } | null;
	imageStatus?: number;
	imageType?: string;
	/** Bytes actually sent for the download. Default 4, the tiny fixture. */
	imageBytes?: number;
	/** Content-Length the download DECLARES. Omitted = no header, like a chunked
	 *  response; set it away from imageBytes to model an upstream that lies. */
	declaredLength?: number;
}) {
	const image = (type = override?.imageType ?? 'image/jpeg') => {
		const headers: Record<string, string> = { 'content-type': type };
		if (override?.declaredLength !== undefined) {
			headers['content-length'] = String(override.declaredLength);
		}
		return new Response(new Uint8Array(override?.imageBytes ?? 4).fill(1), {
			status: 200,
			headers
		});
	};
	async function handle(input: string | URL, init?: RequestInit): Promise<Response> {
		const url = String(input);
		if (url.includes('getProfile')) {
			const profile = override?.profile === undefined ? { avatar: BSKY_AVATAR } : override.profile;
			if (!profile) return new Response('not found', { status: 404 });
			return new Response(JSON.stringify(profile), { status: 200 });
		}
		// Only reachable when the download followed the redirect.
		if (url === REDIRECT_TARGET) return image('image/jpeg');
		// The avatar image download.
		const status = override?.imageStatus ?? 200;
		if (status >= 300 && status < 400) {
			if (init?.redirect !== 'manual') return handle(REDIRECT_TARGET, init);
			// 3xx is a null-body status, so the Response carries none.
			return new Response(null, { status, headers: { location: REDIRECT_TARGET } });
		}
		if (status !== 200) return new Response('nope', { status });
		return image();
	}
	const fetchMock = vi.fn(handle);
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
	// Both spellings, because the refusal reads URL.hostname and only the bracketed
	// form has a port to strip: URL.host would hand isPrivateHost '[::1]:8080',
	// which its anchored IPv6 pattern does not match, and the download would go out.
	it.each(['http://127.0.0.1:8080/x.jpg', 'http://[::1]:8080/x.jpg'])(
		'refuses to download an avatar hosted on a private address (%s)',
		async (avatar) => {
			const fetchMock = stubFetch({ profile: { avatar } });
			const bucket = fakeBucket();
			const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(bucket));
			// Only the profile lookup went out — the download never happened.
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(bucket.put).not.toHaveBeenCalled();
			// Refused, not merely failed: a fallback here would store the internal
			// address and put it in a public <img src>, making the visitor's browser
			// attempt the request this refusal just prevented.
			expect(url).toBeNull();
		}
	);

	// The refusal above must not speak for platforms it never looked at. An artist
	// with both socials whose Bluesky picture sits on a refused host still has a
	// perfectly good Twitter one, and returning null from the whole resolve threw
	// it away.
	it('falls through to Twitter when the Bluesky avatar sits on a refused host', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL) => {
				const url = String(input);
				// Bluesky answers with a link-local address — refused before any download.
				if (url.includes('getProfile')) {
					return new Response(JSON.stringify({ avatar: 'http://169.254.169.254/x.jpg' }), {
						status: 200
					});
				}
				if (url.includes('guest/activate')) {
					return new Response(JSON.stringify({ guest_token: 'gt' }), { status: 200 });
				}
				if (url.includes('UserByScreenName')) {
					const body = {
						data: {
							user: {
								result: {
									legacy: {
										profile_image_url_https: 'https://pbs.twimg.com/profile_images/9/pic_normal.jpg'
									}
								}
							}
						}
					};
					return new Response(JSON.stringify(body), { status: 200 });
				}
				// The twimg download.
				return new Response(new Uint8Array(4).fill(1), {
					status: 200,
					headers: { 'content-type': 'image/jpeg' }
				});
			})
		);
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl(
			{ blueskyUrl: 'nova.bsky.social', twitterUrl: 'https://x.com/nova' },
			r2Ctx(bucket)
		);
		// The Twitter picture was re-hosted and returned; the refused address is
		// still nowhere near the result.
		expect(bucket.put).toHaveBeenCalledTimes(1);
		expect(url).toContain('/avatars/nova/');
		expect(url).not.toContain('169.254');
	});

	it('still prefers Bluesky when it works, even with a Twitter URL alongside', async () => {
		const fetchMock = stubFetch();
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl(
			{ blueskyUrl: 'nova.bsky.social', twitterUrl: 'https://x.com/nova' },
			r2Ctx(bucket)
		);
		expect(url).toContain('/avatars/nova/');
		// Continuing past a refusal must not become continuing past a success:
		// Twitter is never asked when Bluesky answered.
		expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('api.x.com'))).toBe(false);
	});

	it('does not follow redirects on the avatar download', async () => {
		stubFetch({ imageStatus: 302 });
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(bucket));
		// A storage/CDN host answering 3xx is an upstream error, not an invitation
		// to fetch wherever it points. The stub serves real bytes at the redirect
		// target, so dropping redirect:'manual' would store them instead.
		expect(bucket.put).not.toHaveBeenCalled();
		expect(url).toBe(BSKY_AVATAR);
	});

	// The refusal above is right and stays; being unable to tell it apart from a
	// bad morning at one CDN is the problem. A 3xx here would mean avatars moved
	// behind a redirect, which happens to every fork at once and to none of them
	// visibly, since the fallback hotlink still gets written and stamped.
	it('marks a redirect on the context, where an ordinary failure leaves it alone', async () => {
		const bucket = fakeBucket();

		stubFetch({ imageStatus: 302 });
		const redirected = r2Ctx(bucket);
		expect(await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, redirected)).toBe(BSKY_AVATAR);
		expect(redirected.redirected).toBe(true);

		// A 500 is one artist, one morning: same fallback, no flag.
		stubFetch({ imageStatus: 500 });
		const failed = r2Ctx(bucket);
		expect(await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, failed)).toBe(BSKY_AVATAR);
		expect(failed.redirected).toBeFalsy();
	});

	it('logs a redirect as its own event, not as a generic download failure', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stubFetch({ imageStatus: 302 });
		await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(fakeBucket()));
		// Greppable across a fleet's logs, which "rehost download failed status=302"
		// buried among 404s and 500s is not.
		expect(warn.mock.calls.flat().join(' ')).toContain('rehost download redirected');
		warn.mockRestore();
	});

	// The 8s timeout bounds this in practice, not in principle: a fast upstream
	// can hand over hundreds of MB inside it, and this download is now unattended
	// and daily on every fork rather than something an operator watched happen.
	it('refuses a body that declares itself oversize, before reading it', async () => {
		// Four bytes on the wire, so ONLY the Content-Length check can reject this:
		// dropping it lets the read cap wave the response straight through.
		stubFetch({ declaredLength: MAX_AVATAR_BYTES + 1 });
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(bucket));
		expect(bucket.put).not.toHaveBeenCalled();
		// Plain failure, not a REFUSED: the source is a public CDN URL, and the body
		// we declined to hold in the isolate is one a browser streams into an <img>
		// without trouble. So the hotlink stays.
		expect(url).toBe(BSKY_AVATAR);
	});

	it.each([
		['no Content-Length at all', undefined],
		['a Content-Length that lies', 10]
	])('caps the read itself when the upstream sends %s', async (_label, declaredLength) => {
		stubFetch({ imageBytes: MAX_AVATAR_BYTES + 1, declaredLength });
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(bucket));
		expect(bucket.put).not.toHaveBeenCalled();
		expect(url).toBe(BSKY_AVATAR);
	});

	it('refuses an empty 200 rather than storing a blank avatar', async () => {
		// It slips past both size guards: 0 is not over the ceiling, and res.body is
		// non-null for an empty 200. Storing it is the worst outcome available,
		// because the URL is then one of ours and the owner heal's already-ours skip
		// pins the operator on a blank picture the cron will never repair.
		stubFetch({ imageBytes: 0 });
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(bucket));
		expect(bucket.put).not.toHaveBeenCalled();
		// Falls back to the source, so the next run gets another go.
		expect(url).toBe(BSKY_AVATAR);
	});

	it('still stores a body right up to the ceiling', async () => {
		// The boundary matters both ways: a cap that refused everything would also
		// pass every test above while quietly re-hosting nothing at all.
		stubFetch({ imageBytes: MAX_AVATAR_BYTES });
		const bucket = fakeBucket();
		const url = await resolveAvatarUrl({ blueskyUrl: 'nova.bsky.social' }, r2Ctx(bucket));
		expect(bucket.put).toHaveBeenCalledTimes(1);
		expect(url).toContain('/avatars/nova/');
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

	it('reports no backlog at limit 0, which is how the cron says "not opted in"', async () => {
		const { db } = makeDb();
		await db.insert(artists).values([
			{ name: 'A', blueskyUrl: 'a.bsky.social', avatarUrl: null, createdAt: 'x' },
			{ name: 'B', blueskyUrl: 'b.bsky.social', avatarUrl: null, createdAt: 'x' }
		]);

		const r = await refreshArtistAvatars(db, {
			env: { IMAGES: fakeBucket() } as unknown as App.Platform['env'],
			settings: { storageProvider: 'r2', r2PublicUrl: 'https://cdn.test' } as unknown as SiteSettings,
			origin: 'https://site.test',
			limit: 0,
			mode: 'oldest'
		});

		// `remaining: 2` would put a backlog on the daily heartbeat of every site
		// that chose not to refresh artist avatars — one that can never drain.
		expect(r).toEqual({ processed: 0, refreshed: 0, remaining: 0 });
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
	// function must IGNORE, so a test that passes proves it read D1. The snapshot's
	// avatar is a HOTLINK on purpose: an owned one would say "skip" for the same
	// reason D1 does, and every skip test would pass without discriminating.
	const ownerSettings = (over: Partial<SiteSettings> = {}) =>
		({
			storageProvider: 'r2',
			r2PublicUrl: 'https://cdn.test',
			blueskyUrl: 'https://bsky.app/profile/stale.bsky.social',
			adminAvatarUrl: 'https://cdn.bsky.app/img/avatar/plain/did/stale@jpeg',
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

	// Covers the operator who saved a good avatar after the cron took its snapshot
	// too: the snapshot here holds a hotlink, so a heal deciding from it would
	// resolve and overwrite the copy D1 already has.
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
		// A DIFFERENT hotlink from the one the profile hands back. Seeding the same
		// URL would leave the row byte-identical whether the gate refused or wrote,
		// so the fixture could not express the failure it claims to catch.
		const stale = 'https://cdn.bsky.app/img/avatar/plain/did/old@jpeg';
		await seedOwner(db, { adminAvatarUrl: stale });
		// Re-hosting fails, so resolveAvatarUrl falls back to the SOURCE hotlink.
		stubFetch({ imageStatus: 500 });

		const res = await healOwnerAvatar(db, opts(bucket, ownerSettings()));

		// Reported honestly as still broken, and the row is left holding what it
		// held rather than churned with an equivalent bad value. This is the
		// deliberate divergence from shouldWriteAvatar, which WOULD write here:
		// neither URL is ours, so its "no owned avatar to lose" disjunct allows it.
		expect(res).toBe('unresolved');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe(stale);
	});

	// The one failure here that isn't about this fork. If a CDN starts fronting
	// avatars behind a 3xx, every fork stops re-hosting on the same morning and
	// each operator reads the same 'unresolved' they would get from their own
	// broken storage config — so the cause has to survive as far as the outcome.
	it('names a redirect as its own outcome, not as a plain unresolved', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db);
		stubFetch({ imageStatus: 302 });

		const res = await healOwnerAvatar(db, opts(bucket, ownerSettings()));

		expect(res).toBe('redirected');
		// Same conservative write as any other failed heal: the hotlink stays, no
		// copy is stored, and the extra outcome buys visibility only.
		expect(bucket.put).not.toHaveBeenCalled();
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

	// Two forks in one: the one that never set a handle, and the operator who
	// cleared theirs after the cron took its snapshot. saveSite pairs the fields,
	// so clearing bluesky clears the derived avatar with it, while the snapshot
	// still carries a handle and a hotlink — the stale view says heal, and
	// resurrecting an avatar the operator deliberately cleared is exactly what the
	// fresh read prevents.
	it('does nothing when D1 holds no bluesky handle, whatever the snapshot says', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db, { blueskyUrl: '', adminAvatarUrl: '' });

		const res = await healOwnerAvatar(db, opts(bucket, ownerSettings()));

		expect(res).toBe('skipped');
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('');
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
	// workflow_dispatch). This pins that D1 — not the snapshot — supplies the
	// handle, as the two skip tests above pin that it supplies the stored avatar.
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

	// An operator typing a bare hostname into Site URL is ordinary, and without the
	// fallback `new URL('taro.surf')` throws mid-heal: the cron swallows it and the
	// heartbeat reads as a fork with nothing to heal.
	it('falls back to the request origin when the configured Site URL is malformed', async () => {
		const { db } = makeDb();
		const bucket = fakeBucket();
		await seedOwner(db);
		const settings = ownerSettings({ r2PublicUrl: '', siteUrl: 'taro.surf' });

		const res = await healOwnerAvatar(db, opts(bucket, settings, 'https://fork.test'));

		expect(res).toBe('healed');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toMatch(
			/^https:\/\/fork\.test\/img\/avatars\/owner\//
		);
	});
});
