import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';
import { getRawSetting, setRawSetting, parseLines } from '$lib/server/settings';
import { stickerTabEnabled, clearStickerTabCache } from '$lib/server/stickers';
import { MAX_SONA_COLORS } from '$lib/palette-merge';
import { DEFAULT_THEME_ID } from '$lib/themes';
import { DEFAULT_LANDING_LAYOUT } from '$lib/landing';
import { resolveAvatarUrl } from '$lib/server/avatar';
import { verifySupporterKey } from '$lib/server/supporter-key';
import { earlyAccessActive } from '$lib/early-access';
import { formatDate } from '$lib/index';
import { actions, load } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';
import { expInDays } from '$lib/server/test/exp-in-days';

// The avatar re-resolve on the bluesky present-branch would otherwise hit the
// Bluesky API; stub just that export so the save is deterministic and offline
// (the real isOurAvatarUrl/shouldWriteAvatar stay so the guards are exercised
// for real). The default return is an OWNED URL — root-relative '/img/…' is
// ours by definition (no-CDN R2 shape) — i.e. a successful re-host.
vi.mock('$lib/server/avatar', async (importActual) => ({
	...(await importActual<typeof import('$lib/server/avatar')>()),
	resolveAvatarUrl: vi.fn(async () => '/img/avatars/owner/derived.jpg')
}));

// Supporter-key verification needs the sona.fast PRIVATE key to mint a passing
// token, which tests can't have — so stub verify and drive the save/remove/load
// branches by its result. The signature crypto itself is covered in
// supporter-key.test.ts with a real in-test keypair. supporterKeyDisplayDate
// stays real so the formatted dates are exercised.
vi.mock('$lib/server/supporter-key', async (importActual) =>
	(await import('$lib/server/test/supporter-key-mock')).supporterKeyMockModule(
		importActual as () => Promise<typeof import('$lib/server/supporter-key')>
	)
);

function makeDb() {
	const sqlite = new Database(':memory:');
	// artists: the syncNow action runs the real artist-sync against this table.
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

function connectEvent(platform: App.Platform, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	return {
		platform,
		url: new URL('https://taro.surf/admin/settings'),
		request: new Request('https://taro.surf/admin/settings?/connectRegistry', { method: 'POST', body })
	} as never;
}

// Capture the registration request instead of hitting a real registry.
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify({ forkId: 'fork-1', key: 'minted-key' }), { status: 201 })
	);
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function sentBody(): Record<string, unknown> {
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	expect(String(url)).toContain('/v1/forks');
	return JSON.parse(init.body as string);
}

describe('settings connectRegistry — fork key label', () => {
	it('labels the fork key with the configured site name', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'siteName', value: 'Taro Surf' });

		const result = await actions.connectRegistry(connectEvent(platform, { signupToken: 'tok' }));

		expect(result).toMatchObject({ success: true });
		expect(sentBody()).toMatchObject({ signupToken: 'tok', label: 'Taro Surf' });
		// The minted key is persisted so the connection survives without a deploy.
		expect(await getRawSetting(db, REGISTRY_API_KEY_SETTING)).toBe('minted-key');
	});

	it('falls back to the site hostname when no site name is configured', async () => {
		const { platform } = makeDb();

		const result = await actions.connectRegistry(connectEvent(platform, { signupToken: 'tok' }));

		expect(result).toMatchObject({ success: true });
		expect(sentBody()).toMatchObject({ label: 'taro.surf' });
	});
});

function saveSiteEvent(platform: App.Platform, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	return {
		platform,
		url: new URL('https://taro.surf/admin/settings'),
		request: new Request('https://taro.surf/admin/settings?/saveSite', { method: 'POST', body })
	} as never;
}

describe('settings saveSite — /ai disclosure page (SONA-167)', () => {
	// Source pin: the action distinguishes "toggle off" from "form without the
	// toggle" by this hidden marker. Drop it and unchecking the box becomes a
	// silent no-op (absent means unmanaged), with the unit suite still green.
	it('the settings form pairs the toggle with its present-marker', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(src).toMatch(/<input type="hidden" name="aiPageEnabledPresent"/);
		expect(src).toMatch(/<input type="checkbox" name="aiPageEnabled"/);
	});

	it('stores the toggle and the override text, stamping the override date', async () => {
		const { db, platform } = makeDb();

		const result = await actions.saveSite(
			saveSiteEvent(platform, {
				siteName: 'Taro Surf',
				aiPageEnabledPresent: '1',
				aiPageEnabled: 'on',
				aiPageText: 'My own words about AI.'
			})
		);

		expect(result).toMatchObject({ success: true });
		expect(await getRawSetting(db, 'aiPageEnabled')).toBe('true');
		expect(await getRawSetting(db, 'aiPageText')).toBe('My own words about AI.');
		// Stamped like the privacy/terms overrides, so /ai can date owner text.
		expect(await getRawSetting(db, 'aiPageUpdatedAt')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('turns the page off when the form carries the marker but no checkbox', async () => {
		const { db, platform } = makeDb();

		await actions.saveSite(
			saveSiteEvent(platform, { siteName: 'Taro Surf', aiPageEnabledPresent: '1' })
		);

		expect(await getRawSetting(db, 'aiPageEnabled')).toBe('false');
	});

	// The #60 absent-means-unmanaged rule: a checkbox posts nothing when
	// unchecked, so without the marker field a partial save would silently
	// disable a page the owner never touched.
	it('leaves the stored toggle alone when the form does not carry it', async () => {
		const { db, platform } = makeDb();
		await setRawSetting(db, 'aiPageEnabled', 'true');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'Taro Surf' }));

		expect(await getRawSetting(db, 'aiPageEnabled')).toBe('true');
	});
});

describe('settings saveSite — three-path profile fields', () => {
	it('persists the sona profile + contact email and drops malformed swatches', async () => {
		const { db, platform } = makeDb();

		const result = await actions.saveSite(
			saveSiteEvent(platform, {
				siteName: 'Taro Surf',
				splashSubtitle: 'surfing shark',
				contactEmail: 'paws@example.com',
				sonaSpecies: 'Shark',
				sonaBuild: 'Round',
				sonaKeyFeatures: 'Blue fins',
				sonaDos: 'Any style\nShip art is fine',
				sonaDonts: 'No NSFW',
				sonaColors: JSON.stringify([
					{ name: 'Blue', hex: '#3A6EA5' },
					{ name: 'Bad', hex: 'not-a-hex' }
				])
			})
		);

		expect(result).toMatchObject({ success: true });
		expect(await getRawSetting(db, 'contactEmail')).toBe('paws@example.com');
		expect(await getRawSetting(db, 'splashSubtitle')).toBe('surfing shark');
		expect(await getRawSetting(db, 'sonaSpecies')).toBe('Shark');
		// Multipart form encoding normalizes newlines to CRLF (as browsers do);
		// assert through parseLines, which is how /art consumes the value.
		expect(parseLines((await getRawSetting(db, 'sonaDos'))!)).toEqual([
			'Any style',
			'Ship art is fine'
		]);
		// The swatch JSON is re-parsed server-side; entries without a valid hex are dropped.
		expect(JSON.parse((await getRawSetting(db, 'sonaColors'))!)).toEqual([
			{ name: 'Blue', hex: '#3A6EA5' }
		]);
	});

	it('drops duplicate swatches on save (case-insensitive, first wins)', async () => {
		const { db, platform } = makeDb();

		await actions.saveSite(
			saveSiteEvent(platform, {
				sonaColors: JSON.stringify([
					{ name: 'Plum', hex: '#9A5363' },
					{ name: 'Orange', hex: '#F5A572' },
					{ name: 'Plum again', hex: '#9a5363' }
				])
			})
		);

		expect(JSON.parse((await getRawSetting(db, 'sonaColors'))!)).toEqual([
			{ name: 'Plum', hex: '#9A5363' },
			{ name: 'Orange', hex: '#F5A572' }
		]);
	});

	it('clamps the saved swatches to the palette cap', async () => {
		const { db, platform } = makeDb();
		const swatches = Array.from({ length: MAX_SONA_COLORS + 4 }, (_, i) => ({
			name: `c${i}`,
			hex: `#${i.toString(16).padStart(2, '0').repeat(3)}`
		}));

		await actions.saveSite(saveSiteEvent(platform, { sonaColors: JSON.stringify(swatches) }));

		const saved = JSON.parse((await getRawSetting(db, 'sonaColors'))!);
		expect(saved).toHaveLength(MAX_SONA_COLORS);
		expect(saved).toEqual(swatches.slice(0, MAX_SONA_COLORS));
	});
});

describe('settings saveSite — siteUrl + emailLanguage', () => {
	it('saves a valid absolute https URL, normalizing away a trailing slash', async () => {
		const { db, platform } = makeDb();

		const result = await actions.saveSite(
			saveSiteEvent(platform, { siteUrl: 'https://taro.surf/' })
		);

		expect(result).toMatchObject({ success: true });
		expect(await getRawSetting(db, 'siteUrl')).toBe('https://taro.surf');
	});

	it('rejects a non-https / non-absolute URL and persists nothing', async () => {
		const { db, platform } = makeDb();

		const result = await actions.saveSite(saveSiteEvent(platform, { siteUrl: 'taro.surf' }));

		expect(result).toMatchObject({ status: 400 });
		expect(await getRawSetting(db, 'siteUrl')).toBeNull();

		// http (non-https) is also rejected.
		const httpResult = await actions.saveSite(
			saveSiteEvent(platform, { siteUrl: 'http://taro.surf' })
		);
		expect(httpResult).toMatchObject({ status: 400 });
		expect(await getRawSetting(db, 'siteUrl')).toBeNull();
	});

	it('allows an empty siteUrl (falls back to the request origin at send time)', async () => {
		const { db, platform } = makeDb();
		await setRawSetting(db, 'siteUrl', 'https://old.example');

		const result = await actions.saveSite(saveSiteEvent(platform, { siteUrl: '' }));

		expect(result).toMatchObject({ success: true });
		expect(await getRawSetting(db, 'siteUrl')).toBe('');
	});

	it('coerces an unknown emailLanguage to the base locale', async () => {
		const { db, platform } = makeDb();

		await actions.saveSite(saveSiteEvent(platform, { emailLanguage: 'zz' }));
		expect(await getRawSetting(db, 'emailLanguage')).toBe('en');

		await actions.saveSite(saveSiteEvent(platform, { emailLanguage: 'ja' }));
		expect(await getRawSetting(db, 'emailLanguage')).toBe('ja');
	});
});

function saveStorageEvent(platform: App.Platform, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	return {
		platform,
		request: new Request('https://taro.surf/admin/settings?/saveStorage', { method: 'POST', body })
	} as never;
}

describe('settings saveStorage — r2PublicUrl must be origin-only', () => {
	// A path-bearing base would make orphan cleanup derive keys like
	// 'cdn/artwork/x.png' that never match stored keys — every referenced
	// object would look like an orphan on the next sweep.
	it('rejects a base with a path', async () => {
		const { db, platform } = makeDb();

		const result = await actions.saveStorage(
			saveStorageEvent(platform, { storageProvider: 'r2', r2PublicUrl: 'https://example.com/cdn' })
		);

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toContain('origin only');
		// A rejected save persists nothing.
		expect((await getRawSetting(db, 'r2PublicUrl')) ?? '').toBe('');
	});

	it('accepts an origin-only base and normalizes a trailing slash', async () => {
		const { db, platform } = makeDb();

		const result = await actions.saveStorage(
			saveStorageEvent(platform, { storageProvider: 'r2', r2PublicUrl: 'https://cdn.example.com/' })
		);

		expect(result).toMatchObject({ success: true });
		expect(await getRawSetting(db, 'r2PublicUrl')).toBe('https://cdn.example.com');
	});
});

function saveSecurityEmailEvent(platform: App.Platform, adminEmail: string) {
	const body = new FormData();
	body.append('adminEmail', adminEmail);
	return {
		platform,
		request: new Request('https://taro.surf/admin/settings?/saveSecurityEmail', { method: 'POST', body })
	} as never;
}

describe('settings saveSecurityEmail — admin recovery address', () => {
	it('persists a submitted address and reports it saved', async () => {
		const { db, platform } = makeDb();

		const result = await actions.saveSecurityEmail(saveSecurityEmailEvent(platform, 'new@x.y'));

		expect(result).toEqual({ recoveryEmailSaved: true });
		expect(await getRawSetting(db, 'adminEmail')).toBe('new@x.y');
	});

	it('clears the stored address when saved empty (disables email reset)', async () => {
		const { db, platform } = makeDb();
		await setRawSetting(db, 'adminEmail', 'old@x.y');

		const result = await actions.saveSecurityEmail(saveSecurityEmailEvent(platform, ''));

		expect(result).toEqual({ recoveryEmailSaved: true });
		expect(await getRawSetting(db, 'adminEmail')).toBe('');
	});

	it('rejects a value that does not look like an email and leaves the stored address untouched', async () => {
		const { db, platform } = makeDb();
		await setRawSetting(db, 'adminEmail', 'old@x.y');

		const result = await actions.saveSecurityEmail(saveSecurityEmailEvent(platform, 'not-an-email'));

		expect(result).toMatchObject({ status: 400 });
		expect(await getRawSetting(db, 'adminEmail')).toBe('old@x.y');
	});
});

// Schema for tests that drive the full load (which also resolves the ref-sheet
// image for the palette picker, touching images/characters/tags/image_tags).
const LOAD_DDL = `CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, slug TEXT,
		image_url TEXT, thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER,
		md5hash TEXT, nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
		source_post_url TEXT, artist_id INTEGER, collection_id INTEGER, commissioned_at TEXT,
		parent_image_id INTEGER, variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0,
		featured_order INTEGER, created_at TEXT);
	CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
		is_owner INTEGER NOT NULL DEFAULT 0, reference_image_id INTEGER, created_at TEXT);
	CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT);
	CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);`;

const LOAD_URL = new URL('https://taro.surf/admin/settings');

// The load and the supporter-key action read the tz cookie (SONA-119) to render
// the expiry date and its countdown in the operator's zone; absent means UTC,
// which is what these fixed-date assertions expect.
function cookieJar(tz?: string) {
	return { get: (name: string) => (name === 'tz' ? tz : undefined) };
}
function loadEvent(platform: App.Platform, tz?: string) {
	return { platform, url: LOAD_URL, cookies: cookieJar(tz) } as never;
}

describe('settings load — adminEmail is raw, never in public settings', () => {
	it('surfaces the raw adminEmail and keeps it out of the settings object', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(LOAD_DDL);
		const d1 = makeD1(sqlite);
		const db = drizzle(d1, { schema });
		const platform = { env: { DB: d1 } } as unknown as App.Platform;
		await setRawSetting(db, 'adminEmail', 'recover@taro.surf');

		const result = (await load(loadEvent(platform))) as {
			adminEmail: string;
			settings: Record<string, unknown>;
		};

		expect(result.adminEmail).toBe('recover@taro.surf');
		// adminEmail must never leak into the client-exposed SiteSettings.
		expect(result.settings.adminEmail).toBeUndefined();
	});
});

function makeLoadDb(env: Record<string, unknown> = {}) {
	const sqlite = new Database(':memory:');
	sqlite.exec(LOAD_DDL);
	const d1 = makeD1(sqlite);
	return {
		db: drizzle(d1, { schema }),
		platform: { env: { DB: d1, ...env } } as unknown as App.Platform
	};
}

describe('settings load — Resend config exposes presence only', () => {
	it('reports both secrets as set without echoing their values', async () => {
		const { platform } = makeLoadDb({
			RESEND_API_KEY: 're_secret_value',
			RESEND_FROM: 'Sona <hi@example.com>'
		});

		const result = (await load(loadEvent(platform))) as unknown as Record<string, unknown>;

		expect(result.resendKeySet).toBe(true);
		expect(result.resendFromSet).toBe(true);
		// Presence only — the secret strings must never appear anywhere in the payload.
		expect(JSON.stringify(result)).not.toContain('re_secret_value');
		expect(JSON.stringify(result)).not.toContain('hi@example.com');
	});

	it('reports both secrets as unset when the env vars are absent', async () => {
		const { platform } = makeLoadDb({});

		const result = (await load(loadEvent(platform))) as unknown as Record<string, unknown>;

		expect(result.resendKeySet).toBe(false);
		expect(result.resendFromSet).toBe(false);
	});

	it('treats an empty-string secret as unset (a blank binding is not configured)', async () => {
		const { platform } = makeLoadDb({ RESEND_API_KEY: '', RESEND_FROM: '' });

		const result = (await load(loadEvent(platform))) as unknown as Record<string, unknown>;

		expect(result.resendKeySet).toBe(false);
		expect(result.resendFromSet).toBe(false);
	});
});

describe('settings load — ref-sheet picker source', () => {
	it('is null when no reference sheet exists (the UI shows a designate-one hint)', async () => {
		const { platform } = makeLoadDb();

		const result = (await load(loadEvent(platform))) as unknown as {
			refImageSrc: unknown;
		};

		expect(result.refImageSrc).toBeNull();
	});

	it('resolves the newest published reference-tagged image with a client strategy', async () => {
		const { db, platform } = makeLoadDb();
		const img = await db
			.insert(schema.images)
			.values({
				title: 'ref',
				slug: 'ref',
				imageUrl: 'https://abc12.ufs.sh/f/key',
				artistId: 1,
				createdAt: '2026-01-01'
			})
			.returning({ id: schema.images.id })
			.get();
		const tag = await db.insert(schema.tags).values({ name: 'reference' }).returning({ id: schema.tags.id }).get();
		await db.insert(schema.imageTags).values({ imageId: img.id, tagId: tag.id });

		const result = (await load(loadEvent(platform))) as unknown as {
			refImageSrc: { src: string; crossorigin: boolean };
		};

		// UploadThing host → raw URL + crossorigin (see ref-image.test.ts for the
		// full strategy matrix; this just proves the load wires it through).
		expect(result.refImageSrc).toEqual({ src: 'https://abc12.ufs.sh/f/key', crossorigin: true });
	});
});

describe('settings connectRegistry — reconnect guard', () => {
	it('refuses to mint a second key while one is already stored', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'existing-key' });

		const result = await actions.connectRegistry(connectEvent(platform, { signupToken: 'tok' }));

		expect(result).toMatchObject({ status: 400, data: { alreadyConnected: true } });
		// No registration request went out, and the stored key is untouched.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await getRawSetting(db, REGISTRY_API_KEY_SETTING)).toBe('existing-key');
	});
});

describe('settings syncNow — a refusal is a localizable reason, not a raw message', () => {
	function syncEvent(platform: App.Platform) {
		return { platform } as never;
	}

	// The action must hand back a REASON, not the thrown message: the page wraps it in
	// m.admin_settings_sync_refused so a Japanese operator doesn't get English internals.
	it('502s with the registry reason (and no raw message) when the fork key is refused', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'revoked-key' });
		vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) =>
			Promise.resolve(
				String(input).includes('/v1/artists?')
					? new Response(JSON.stringify({ error: 'invalid fork key' }), {
							status: 401,
							headers: { 'content-type': 'application/json' }
						})
					: new Response(JSON.stringify({ artists: [] }), { status: 200 })
			)
		);

		const result = (await actions.syncNow(syncEvent(platform))) as {
			status: number;
			data: { syncRefusedReason?: string; error?: string };
		};

		expect(result.status).toBe(502);
		expect(result.data.syncRefusedReason).toBe('invalid fork key');
		// No untranslated internals ("registry delta refused: HTTP 401 …") in the payload.
		expect(result.data.error).toBeUndefined();
	});

	it('400s when the shared registry is not configured', async () => {
		const { platform } = makeDb();

		const result = await actions.syncNow(syncEvent(platform));
		expect(result).toMatchObject({ status: 400 });
	});

	it('succeeds with a summary on a healthy sync', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'good-key' });
		vi.mocked(fetch).mockImplementation(() =>
			Promise.resolve(
				new Response(JSON.stringify({ artists: [], nextCursor: null }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
			)
		);

		const result = (await actions.syncNow(syncEvent(platform))) as {
			success: boolean;
			syncMessage: string;
		};
		expect(result.success).toBe(true);
		expect(result.syncMessage).toMatch(/Sync complete/);
	});
});

// saveSite must distinguish a field ABSENT from the POST (skip — the posting
// form doesn't manage that setting) from a field PRESENT but blank (deliberate
// clear). Conditionally-rendered fields (splash subtitle, sona sheet, theme
// pickers) were otherwise silently blanked by saves from forms that don't
// render them (#60 — Sunday's splash subtitle kept reverting to the fallback).
async function seed(db: ReturnType<typeof makeDb>['db'], key: string, value: string) {
	await db.insert(siteSettings).values({ key, value });
}

describe('saveSite — absent fields are skipped, blank fields clear (#60)', () => {
	it('a POST omitting splashSubtitle leaves the stored value intact', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'splashSubtitle', 'shiba supreme');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'sheeb.net' }));

		expect(await getRawSetting(db, 'splashSubtitle')).toBe('shiba supreme');
		expect(await getRawSetting(db, 'siteName')).toBe('sheeb.net');
	});

	it('a POST with splashSubtitle present-but-blank clears it deliberately', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'splashSubtitle', 'shiba supreme');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'sheeb.net', splashSubtitle: '' }));

		expect(await getRawSetting(db, 'splashSubtitle')).toBe('');
	});

	it('a POST omitting themeId/landingLayout does not reset them to defaults', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'themeId', 'terracotta');
		await seed(db, 'landingLayout', 'threePath');

		await actions.saveSite(saveSiteEvent(platform, { ownerName: 'Sunday' }));

		expect(await getRawSetting(db, 'themeId')).toBe('terracotta');
		expect(await getRawSetting(db, 'landingLayout')).toBe('threePath');
	});

	it('a POST omitting bluesky leaves blueskyUrl and the derived avatar alone', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'blueskyUrl', 'https://bsky.app/profile/sunday.bsky.social');
		await seed(db, 'adminAvatarUrl', 'https://cdn.bsky.app/img/avatar/plain/x');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'sheeb.net' }));

		expect(await getRawSetting(db, 'blueskyUrl')).toBe('https://bsky.app/profile/sunday.bsky.social');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('https://cdn.bsky.app/img/avatar/plain/x');
	});

	it('a POST omitting sonaColors keeps the stored swatches', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'sonaColors', '[{"name":"fur","hex":"#DD5131"}]');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'sheeb.net' }));

		expect(await getRawSetting(db, 'sonaColors')).toBe('[{"name":"fur","hex":"#DD5131"}]');
	});
});

describe('settings saveSite — legal "last updated" stamps', () => {
	it('does not stamp when a non-legal field changes', async () => {
		const { db, platform } = makeDb();

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'New' }));

		// No legal field in the POST → neither page's stamp is written.
		expect(await getRawSetting(db, 'privacyUpdatedAt')).toBeNull();
		expect(await getRawSetting(db, 'termsUpdatedAt')).toBeNull();
	});

	it('does not re-stamp when the policy text is unchanged', async () => {
		const { db, platform } = makeDb();
		await setRawSetting(db, 'privacyPolicy', 'X');
		await setRawSetting(db, 'privacyUpdatedAt', '2026-01-01');

		await actions.saveSite(saveSiteEvent(platform, { privacyPolicy: 'X', siteName: 'New' }));

		expect(await getRawSetting(db, 'privacyUpdatedAt')).toBe('2026-01-01');
	});

	it('stamps only the page whose text changed', async () => {
		const { db, platform } = makeDb();
		await setRawSetting(db, 'privacyPolicy', 'X');
		await setRawSetting(db, 'privacyUpdatedAt', '2026-01-01');

		await actions.saveSite(
			saveSiteEvent(platform, { privacyPolicy: 'X', termsOfService: 'Brand new terms' })
		);

		// Privacy text unchanged → its stamp stays; terms changed → stamped today.
		expect(await getRawSetting(db, 'privacyUpdatedAt')).toBe('2026-01-01');
		expect(await getRawSetting(db, 'termsUpdatedAt')).toBe(new Date().toISOString().slice(0, 10));
	});

	it('stamps the changed policy with today\'s date', async () => {
		const { db, platform } = makeDb();

		await actions.saveSite(saveSiteEvent(platform, { privacyPolicy: 'A fresh custom policy' }));

		expect(await getRawSetting(db, 'privacyUpdatedAt')).toBe(new Date().toISOString().slice(0, 10));
	});

	it('does not stamp when an override is cleared to empty', async () => {
		const { db, platform } = makeDb();
		await setRawSetting(db, 'privacyPolicy', 'X');
		await setRawSetting(db, 'privacyUpdatedAt', '2026-01-01');

		// Present-but-blank clears the override back to the built-in defaults; the
		// stamp is left untouched (and unread) rather than advanced to today.
		await actions.saveSite(saveSiteEvent(platform, { privacyPolicy: '' }));

		expect(await getRawSetting(db, 'privacyUpdatedAt')).toBe('2026-01-01');
	});
});

// The social() helper is absent → skip, present-blank → clear, present-value →
// save. normalizeSocialUrl is unit-tested on its own; these pin the three
// directions at the action level (twitter stands in for the non-bluesky
// socials, which share the exact same code path).
describe('settings saveSite — social() field directions', () => {
	it('a POST omitting a social leaves the stored value intact', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'twitterUrl', 'https://twitter.com/sona.e2e.example');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'sheeb.net' }));

		expect(await getRawSetting(db, 'twitterUrl')).toBe('https://twitter.com/sona.e2e.example');
	});

	it('a POST with a social present-but-blank clears it', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'twitterUrl', 'https://twitter.com/sona.e2e.example');

		await actions.saveSite(saveSiteEvent(platform, { twitter: '' }));

		expect(await getRawSetting(db, 'twitterUrl')).toBe('');
	});

	it('a POST with a social present-value normalizes and saves it', async () => {
		const { db, platform } = makeDb();

		await actions.saveSite(saveSiteEvent(platform, { twitter: 'sona.e2e.example' }));

		// A bare handle is normalized to the canonical profile URL before storage.
		expect(await getRawSetting(db, 'twitterUrl')).toBe('https://twitter.com/sona.e2e.example');
	});

	it('saves the instagram field under the instagramUrl key', async () => {
		const { db, platform } = makeDb();

		await actions.saveSite(saveSiteEvent(platform, { instagram: 'sona.e2e.example' }));

		expect(await getRawSetting(db, 'instagramUrl')).toBe('https://www.instagram.com/sona.e2e.example');
	});
});

// The absent-bluesky branch is covered above; these pin the present branch,
// where the derived avatar is paired to the bluesky field.
describe('settings saveSite — bluesky present-branch re-resolves the avatar', () => {
	it('a present bluesky updates both blueskyUrl and the derived avatar', async () => {
		const { db, platform } = makeDb();
		vi.mocked(resolveAvatarUrl).mockClear();

		await actions.saveSite(saveSiteEvent(platform, { bluesky: 'sunday.bsky.social' }));

		expect(await getRawSetting(db, 'blueskyUrl')).toBe(
			'https://bsky.app/profile/sunday.bsky.social'
		);
		expect(resolveAvatarUrl).toHaveBeenCalledWith(
			{ blueskyUrl: 'https://bsky.app/profile/sunday.bsky.social' },
			expect.objectContaining({ keyHint: 'owner', origin: 'https://taro.surf' })
		);
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('/img/avatars/owner/derived.jpg');
	});

	it('a present-but-blank bluesky clears both blueskyUrl and the avatar', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'blueskyUrl', 'https://bsky.app/profile/sunday.bsky.social');
		await seed(db, 'adminAvatarUrl', 'https://cdn.bsky.app/img/avatar/plain/x');
		vi.mocked(resolveAvatarUrl).mockClear();

		await actions.saveSite(saveSiteEvent(platform, { bluesky: '' }));

		expect(await getRawSetting(db, 'blueskyUrl')).toBe('');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('');
		// No avatar lookup when bluesky is cleared — the avatar clears with it.
		expect(resolveAvatarUrl).not.toHaveBeenCalled();
	});

	// Unchanged-handle guard (#187): the site tab posts bluesky on EVERY save, and
	// no cron heals the owner avatar — an unrelated save (a transient resolve
	// failure included) must not degrade an owned re-hosted copy. With the handle
	// unchanged AND the avatar already ours, nothing could change, so the resolve
	// is skipped entirely (which is also what keeps a transient failure harmless).
	it('an UNCHANGED handle with an owned avatar skips re-resolution and keeps the avatar', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'blueskyUrl', 'https://bsky.app/profile/sunday.bsky.social');
		// Root-relative '/img/…' is ours by definition (no-CDN R2 shape).
		await seed(db, 'adminAvatarUrl', '/img/avatars/owner/owned.jpg');
		vi.mocked(resolveAvatarUrl).mockClear();

		await actions.saveSite(saveSiteEvent(platform, { bluesky: 'sunday.bsky.social' }));

		expect(resolveAvatarUrl).not.toHaveBeenCalled(); // no profile lookup, no re-host
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('/img/avatars/owner/owned.jpg');
	});

	it('an unchanged handle still re-hosts when the stored avatar is a hotlink (skip is ownership-gated)', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'blueskyUrl', 'https://bsky.app/profile/sunday.bsky.social');
		await seed(db, 'adminAvatarUrl', 'https://cdn.bsky.app/img/avatar/plain/rot.jpg');
		vi.mocked(resolveAvatarUrl).mockClear();

		await actions.saveSite(saveSiteEvent(platform, { bluesky: 'sunday.bsky.social' }));

		expect(resolveAvatarUrl).toHaveBeenCalledTimes(1);
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('/img/avatars/owner/derived.jpg');
	});

	// A handle CHANGE is authoritative (#197 review): when the new handle can't be
	// resolved+re-hosted, the OLD account's face must not persist under it.
	it('a CHANGED handle clears the owner avatar when resolution fails (null)', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'blueskyUrl', 'https://bsky.app/profile/old.bsky.social');
		await seed(db, 'adminAvatarUrl', '/img/avatars/owner/owned.jpg');
		vi.mocked(resolveAvatarUrl).mockResolvedValueOnce(null);

		await actions.saveSite(saveSiteEvent(platform, { bluesky: 'new.bsky.social' }));

		expect(await getRawSetting(db, 'blueskyUrl')).toBe('https://bsky.app/profile/new.bsky.social');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('');
	});

	it('a CHANGED handle clears instead of writing a hotlink fallback', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'blueskyUrl', 'https://bsky.app/profile/old.bsky.social');
		await seed(db, 'adminAvatarUrl', '/img/avatars/owner/owned.jpg');
		// Re-host failed → resolveAvatarUrl falls back to the new account's hotlink;
		// storing a rot-prone hotlink for the owner (no cron heals it) is worse than
		// clearing and re-saving once storage recovers.
		vi.mocked(resolveAvatarUrl).mockResolvedValueOnce(
			'https://cdn.bsky.app/img/avatar/plain/hotlink'
		);

		await actions.saveSite(saveSiteEvent(platform, { bluesky: 'new.bsky.social' }));

		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('');
	});
});

// The omit case is covered above. Settings COERCES an invalid enum to the
// default (unlike the wizard, which fail(400)s per #34); asserted only in the
// wizard's separate copy before now, so a settings-only regression would pass.
describe('settings saveSite — themeId/landingLayout present-branch', () => {
	it('saves a valid themeId and landingLayout as submitted', async () => {
		const { db, platform } = makeDb();

		await actions.saveSite(
			saveSiteEvent(platform, { themeId: 'terracotta', landingLayout: 'threePath' })
		);

		expect(await getRawSetting(db, 'themeId')).toBe('terracotta');
		expect(await getRawSetting(db, 'landingLayout')).toBe('threePath');
	});

	it('coerces an unrecognized themeId and landingLayout to their defaults', async () => {
		const { db, platform } = makeDb();

		await actions.saveSite(saveSiteEvent(platform, { themeId: 'neon', landingLayout: 'hero' }));

		expect(await getRawSetting(db, 'themeId')).toBe(DEFAULT_THEME_ID);
		expect(await getRawSetting(db, 'landingLayout')).toBe(DEFAULT_LANDING_LAYOUT);
	});
});

function saveSupporterKeyEvent(platform: App.Platform, key: string, tz?: string) {
	const body = new FormData();
	body.append('supporterKey', key);
	return {
		platform,
		cookies: cookieJar(tz),
		request: new Request('https://taro.surf/admin/settings?/saveSupporterKey', { method: 'POST', body })
	} as never;
}

function removeSupporterKeyEvent(platform: App.Platform) {
	return {
		platform,
		request: new Request('https://taro.surf/admin/settings?/removeSupporterKey', {
			method: 'POST',
			body: new FormData()
		})
	} as never;
}

describe('settings saveSupporterKey — store only verified, in-date keys (SONA-105)', () => {
	it('stores a key that verifies and is not expired, whitespace stripped', async () => {
		const { db, platform } = makeDb();
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: new Date('2026-09-01T00:00:00Z')
		});

		// Paste carries display-wrap whitespace; the stored value is stripped.
		const result = await actions.saveSupporterKey(saveSupporterKeyEvent(platform, 'head.\n tail '));

		expect(result).toEqual({ supporterKeySaved: true });
		expect(await getRawSetting(db, 'supporterKey')).toBe('head.tail');
	});

	it('dates the expired-paste error in the tz cookie zone', async () => {
		const { platform } = makeDb();
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: false,
			reason: 'expired',
			login: 'sparky',
			tier: 1,
			expiresAt: new Date('2026-08-18T00:00:00Z')
		});

		const result = await actions.saveSupporterKey(
			saveSupporterKeyEvent(platform, 'head.tail', 'Asia/Tokyo')
		);

		expect(result).toMatchObject({
			data: { supporterKeyError: 'expired', supporterKeyExpiredDate: '2026.08.18' }
		});
	});

	it('rejects an unverifiable key with the invalid error and stores nothing', async () => {
		const { db, platform } = makeDb();
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({ valid: false, reason: 'bad-signature' });

		const result = await actions.saveSupporterKey(saveSupporterKeyEvent(platform, 'bogus.token'));

		expect(result).toMatchObject({ status: 400, data: { supporterKeyError: 'invalid' } });
		expect(await getRawSetting(db, 'supporterKey')).toBeNull();
	});

	it('rejects an expired paste with the dated expired error and stores nothing', async () => {
		const { db, platform } = makeDb();
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: false,
			reason: 'expired',
			login: 'sparky',
			tier: 1,
			expiresAt: new Date('2026-07-11T00:00:00Z')
		});

		const result = await actions.saveSupporterKey(saveSupporterKeyEvent(platform, 'old.token'));

		expect(result).toMatchObject({
			status: 400,
			data: { supporterKeyError: 'expired', supporterKeyExpiredDate: '2026.07.10' }
		});
		expect(await getRawSetting(db, 'supporterKey')).toBeNull();
	});

	it('rejects an empty submission as invalid', async () => {
		const { platform } = makeDb();
		vi.mocked(verifySupporterKey).mockClear();

		const result = await actions.saveSupporterKey(saveSupporterKeyEvent(platform, '   '));

		expect(result).toMatchObject({ status: 400, data: { supporterKeyError: 'invalid' } });
		expect(verifySupporterKey).not.toHaveBeenCalled();
	});
});

describe('settings removeSupporterKey — clears the stored key', () => {
	it('clears a stored supporter key', async () => {
		const { db, platform } = makeDb();
		await setRawSetting(db, 'supporterKey', 'head.tail');

		const result = await actions.removeSupporterKey(removeSupporterKeyEvent(platform));

		expect(result).toEqual({ supporterKeyRemoved: true });
		expect(await getRawSetting(db, 'supporterKey')).toBe('');
	});
});

describe('settings load — supporter key is raw + verified, never in public settings', () => {
	it('surfaces a verified key as valid and keeps the token out of settings', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: new Date('2026-09-01T00:00:00Z')
		});

		const result = (await load(loadEvent(platform))) as unknown as {
			supporterKey: { token: string; state: string; validUntil: string } | null;
			earlyAccess: unknown[];
			settings: Record<string, unknown>;
		};

		// Exact shape on purpose: any NEW field added to the payload must be
		// re-reviewed here before it rides to the client alongside the token.
		expect(result.supporterKey).toEqual({
			token: 'head.tail',
			state: 'valid',
			validUntil: '2026.08.31',
			// UTC-pinned twin of validUntil; keys the dismissal cookie (SONA-119).
			dismissKey: '2026.08.31',
			daysRemaining: expect.any(Number),
			expiringSoon: expect.any(Boolean)
		});
		// The registry no longer ships empty (vr-avatars is the first entry), so
		// derive the expectation from it: any flag inside its window at load time
		// surfaces as flag + display-formatted GA date — and nothing else rides
		// along (a NEW field in the mapping must be re-reviewed here first).
		expect(result.earlyAccess).toEqual(
			earlyAccessActive(new Date()).map((e) => ({ flag: e.flag, gaDate: formatDate(e.gaDate) }))
		);
		// The token must never leak into the client-exposed SiteSettings.
		expect(result.settings.supporterKey).toBeUndefined();
	});

	it('surfaces an expired key as expired (still shown, with its date)', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'old.token');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: false,
			reason: 'expired',
			login: 'sparky',
			tier: 1,
			expiresAt: new Date('2026-07-11T00:00:00Z')
		});

		const result = (await load(loadEvent(platform))) as unknown as {
			supporterKey: { state: string; validUntil: string } | null;
		};

		expect(result.supporterKey).toMatchObject({ state: 'expired', validUntil: '2026.07.10' });
	});

	it('falls through to no key when a stored token no longer verifies', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'corrupt');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({ valid: false, reason: 'malformed' });

		const result = (await load(loadEvent(platform))) as unknown as {
			supporterKey: unknown;
		};

		expect(result.supporterKey).toBeNull();
	});
});

describe('settings load — expiring-soon boundary (SONA-114)', () => {

	async function loadWithExpiry(expiresAt: Date) {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt
		});
		return (await load(loadEvent(platform))) as unknown as {
			supporterKey: { state: string; daysRemaining: number; expiringSoon: boolean } | null;
		};
	}

	it('flags a key just inside the 7-day window', async () => {
		// 7 calendar days out — the last value inside the window.
		const result = await loadWithExpiry(expInDays(7));
		expect(result.supporterKey).toMatchObject({ state: 'valid', daysRemaining: 7, expiringSoon: true });
	});

	it('does not flag a key just outside the window', async () => {
		// 8 calendar days out — the first value outside.
		const result = await loadWithExpiry(expInDays(8));
		expect(result.supporterKey).toMatchObject({ state: 'valid', daysRemaining: 8, expiringSoon: false });
	});

	it('reports 1 day remaining on the key\'s last covered day', async () => {
		const result = await loadWithExpiry(expInDays(1));
		expect(result.supporterKey).toMatchObject({ state: 'valid', daysRemaining: 1, expiringSoon: true });
	});

	// SONA-119: the load dates the card in the operator's zone, so the date and
	// the countdown next to it are read off one instant in one zone. Without the
	// cookie reaching resolveSupporterKeyStatus this stays on UTC for everyone.
	it('dates the card in the tz cookie zone', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		// Once per load below — a persistent mock would leak into later tests if an
		// assertion here threw before the reset.
		const verified = {
			valid: true,
			login: 'sparky',
			tier: 2,
			// Last covered instant 2026-08-17T23:59:59Z — the 17th in UTC, already
			// the 18th anywhere east of it.
			expiresAt: new Date('2026-08-18T00:00:00Z')
		} as const;
		vi.mocked(verifySupporterKey).mockResolvedValueOnce(verified).mockResolvedValueOnce(verified);

		const utc = (await load(loadEvent(platform))) as unknown as {
			supporterKey: { validUntil: string };
		};
		const tokyo = (await load(loadEvent(platform, 'Asia/Tokyo'))) as unknown as {
			supporterKey: { validUntil: string };
		};

		expect(utc.supporterKey.validUntil).toBe('2026.08.17');
		expect(tokyo.supporterKey.validUntil).toBe('2026.08.18');
	});

	it('an expired key is expired, never expiring-soon', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', 'old.token');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: false,
			reason: 'expired',
			login: 'sparky',
			tier: 1,
			expiresAt: expInDays(-1)
		});

		const result = (await load(loadEvent(platform))) as unknown as {
			supporterKey: { state: string; daysRemaining: number; expiringSoon: boolean } | null;
		};

		expect(result.supporterKey).toMatchObject({ state: 'expired', daysRemaining: 0, expiringSoon: false });
	});
});

describe('deleteAll — every content table in the backup is wiped', () => {
	it('removes VR avatars, sticker packs, fursuit photos and conventions (FK order + cascades)', async () => {
		// Full-schema in-memory DB with REAL foreign keys: vr_avatars.character_id,
		// sticker_packs.character_id and *.artist_id reference characters/artists
		// WITHOUT cascade, so if deleteAll ordered the characters/artists deletes
		// first, this test fails with a FOREIGN KEY constraint error — the
		// regression it exists to catch. The child tables prove the ON DELETE
		// cascades instead (credits/media/platforms; stickers → sticker_emojis).
		const sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		sqlite.exec(`
			CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT);
			CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT);
			CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, image_url TEXT NOT NULL);
			CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
			CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
			CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
			CREATE TABLE image_characters (image_id INTEGER NOT NULL, character_id INTEGER NOT NULL);
			CREATE TABLE vr_avatars (
				id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, name TEXT NOT NULL,
				character_id INTEGER NOT NULL REFERENCES characters(id),
				model_url TEXT, downloadable INTEGER NOT NULL DEFAULT 0, nsfw INTEGER NOT NULL DEFAULT 0,
				published INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
			);
			CREATE TABLE avatar_credits (
				avatar_id INTEGER NOT NULL REFERENCES vr_avatars(id) ON DELETE CASCADE,
				artist_id INTEGER NOT NULL REFERENCES artists(id),
				role TEXT NOT NULL, role_label TEXT, position INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE avatar_media (
				avatar_id INTEGER NOT NULL REFERENCES vr_avatars(id) ON DELETE CASCADE,
				kind TEXT NOT NULL, url TEXT NOT NULL, width INTEGER, height INTEGER,
				position INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE avatar_platforms (
				avatar_id INTEGER NOT NULL REFERENCES vr_avatars(id) ON DELETE CASCADE,
				platform TEXT NOT NULL
			);
			CREATE TABLE sticker_packs (
				id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL,
				character_id INTEGER NOT NULL REFERENCES characters(id),
				manager_artist_id INTEGER REFERENCES artists(id),
				source TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1, created_at TEXT
			);
			CREATE TABLE stickers (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				pack_id INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
				artist_id INTEGER REFERENCES artists(id),
				image_url TEXT NOT NULL
			);
			CREATE TABLE sticker_emojis (
				sticker_id INTEGER NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
				emoji TEXT NOT NULL
			);
			CREATE TABLE fursuit_photos (
				id INTEGER PRIMARY KEY AUTOINCREMENT, furtrack_post_id INTEGER NOT NULL,
				character TEXT NOT NULL, image_url TEXT NOT NULL, photographer TEXT NOT NULL,
				license TEXT NOT NULL, furtrack_url TEXT NOT NULL, created_at TEXT NOT NULL
			);
			CREATE TABLE conventions (
				id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
				start_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', created_at TEXT NOT NULL
			);
		`);
		sqlite.prepare('INSERT INTO characters (id, name) VALUES (1, ?)').run('Taro');
		sqlite.prepare('INSERT INTO artists (id, name) VALUES (1, ?)').run('Alba');
		sqlite
			.prepare(
				"INSERT INTO vr_avatars (id, slug, name, character_id, model_url, created_at) VALUES (1, 'taro', 'Taro', 1, '/img/vr-models/taro.vrm', '2026-08-01')"
			)
			.run();
		sqlite.prepare("INSERT INTO avatar_credits (avatar_id, artist_id, role) VALUES (1, 1, 'modeler')").run();
		sqlite.prepare("INSERT INTO avatar_media (avatar_id, kind, url) VALUES (1, 'image', '/img/vr-media/a.png')").run();
		sqlite.prepare("INSERT INTO avatar_platforms (avatar_id, platform) VALUES (1, 'vrchat')").run();
		sqlite
			.prepare(
				"INSERT INTO sticker_packs (id, name, slug, character_id, manager_artist_id, source) VALUES (1, 'Taro Pack', 'taro-pack', 1, 1, 'self-hosted')"
			)
			.run();
		sqlite.prepare("INSERT INTO stickers (id, pack_id, artist_id, image_url) VALUES (1, 1, 1, '/img/stickers/a.webp')").run();
		sqlite.prepare("INSERT INTO sticker_emojis (sticker_id, emoji) VALUES (1, '🦊')").run();
		sqlite
			.prepare(
				"INSERT INTO fursuit_photos (furtrack_post_id, character, image_url, photographer, license, furtrack_url, created_at) VALUES (7, 'Taro', '/f.jpg', 'Cam', 'cc-by', 'https://furtrack.example/7', '2026-08-01')"
			)
			.run();
		sqlite.prepare("INSERT INTO conventions (name, start_date, created_at) VALUES ('FC', '2027-01-14', '2026-08-01')").run();
		sqlite.prepare("INSERT INTO images (id, image_url) VALUES (1, '/img/uploads/a.png')").run();
		sqlite.prepare("INSERT INTO tags (id, name) VALUES (1, 'fox')").run();
		sqlite.prepare("INSERT INTO collections (id, name) VALUES (1, 'Faves')").run();
		sqlite.prepare('INSERT INTO image_tags (image_id, tag_id) VALUES (1, 1)').run();
		sqlite.prepare('INSERT INTO image_characters (image_id, character_id) VALUES (1, 1)').run();

		const d1 = makeD1(sqlite);
		const platform = { env: { DB: d1 } } as unknown as App.Platform;
		// Prime a nav-probe cache with pre-wipe truth: a published pack exists.
		const probeDb = drizzle(d1, { schema });
		clearStickerTabCache();
		expect(await stickerTabEnabled(probeDb)).toBe(true);

		const result = (await actions.deleteAll({ platform } as never)) as { success?: boolean };
		expect(result).toMatchObject({ success: true });

		// deleteAll must clear the per-isolate probe caches — without it, this
		// still serves the primed `true` (a ghost Stickers pill) for up to the TTL.
		expect(await stickerTabEnabled(probeDb)).toBe(false);

		for (const table of [
			'vr_avatars',
			'avatar_credits',
			'avatar_media',
			'avatar_platforms',
			'sticker_packs',
			'stickers',
			'sticker_emojis',
			'fursuit_photos',
			'conventions',
			'images',
			'image_tags',
			'image_characters',
			'tags',
			'collections',
			'characters',
			'artists'
		]) {
			const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
			expect(row.n, `${table} should be empty after deleteAll`).toBe(0);
		}
	});
});
