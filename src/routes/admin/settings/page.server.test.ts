import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';
import { getRawSetting, setRawSetting, parseLines } from '$lib/server/settings';
import { MAX_SONA_COLORS } from '$lib/palette-merge';
import { DEFAULT_THEME_ID } from '$lib/themes';
import { DEFAULT_LANDING_LAYOUT } from '$lib/landing';
import { resolveAvatarUrl } from '$lib/server/avatar';
import { actions, load } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

// The avatar re-resolve on the bluesky present-branch would otherwise hit the
// Bluesky API; stub it so the save is deterministic and offline.
vi.mock('$lib/server/avatar', () => ({
	resolveAvatarUrl: vi.fn(async () => 'https://cdn.bsky.app/img/avatar/plain/derived')
}));

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
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
		request: new Request('https://taro.surf/admin/settings?/saveSite', { method: 'POST', body })
	} as never;
}

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

describe('settings load — adminEmail is raw, never in public settings', () => {
	it('surfaces the raw adminEmail and keeps it out of the settings object', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(LOAD_DDL);
		const d1 = makeD1(sqlite);
		const db = drizzle(d1, { schema });
		const platform = { env: { DB: d1 } } as unknown as App.Platform;
		await setRawSetting(db, 'adminEmail', 'recover@taro.surf');

		const result = (await load({ platform, url: LOAD_URL } as never)) as {
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

		const result = (await load({ platform, url: LOAD_URL } as never)) as unknown as Record<string, unknown>;

		expect(result.resendKeySet).toBe(true);
		expect(result.resendFromSet).toBe(true);
		// Presence only — the secret strings must never appear anywhere in the payload.
		expect(JSON.stringify(result)).not.toContain('re_secret_value');
		expect(JSON.stringify(result)).not.toContain('hi@example.com');
	});

	it('reports both secrets as unset when the env vars are absent', async () => {
		const { platform } = makeLoadDb({});

		const result = (await load({ platform, url: LOAD_URL } as never)) as unknown as Record<string, unknown>;

		expect(result.resendKeySet).toBe(false);
		expect(result.resendFromSet).toBe(false);
	});

	it('treats an empty-string secret as unset (a blank binding is not configured)', async () => {
		const { platform } = makeLoadDb({ RESEND_API_KEY: '', RESEND_FROM: '' });

		const result = (await load({ platform, url: LOAD_URL } as never)) as unknown as Record<string, unknown>;

		expect(result.resendKeySet).toBe(false);
		expect(result.resendFromSet).toBe(false);
	});
});

describe('settings load — ref-sheet picker source', () => {
	it('is null when no reference sheet exists (the UI shows a designate-one hint)', async () => {
		const { platform } = makeLoadDb();

		const result = (await load({ platform, url: LOAD_URL } as never)) as unknown as {
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

		const result = (await load({ platform, url: LOAD_URL } as never)) as unknown as {
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
		await seed(db, 'twitterUrl', 'https://twitter.com/taro');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'sheeb.net' }));

		expect(await getRawSetting(db, 'twitterUrl')).toBe('https://twitter.com/taro');
	});

	it('a POST with a social present-but-blank clears it', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'twitterUrl', 'https://twitter.com/taro');

		await actions.saveSite(saveSiteEvent(platform, { twitter: '' }));

		expect(await getRawSetting(db, 'twitterUrl')).toBe('');
	});

	it('a POST with a social present-value normalizes and saves it', async () => {
		const { db, platform } = makeDb();

		await actions.saveSite(saveSiteEvent(platform, { twitter: 'taro' }));

		// A bare handle is normalized to the canonical profile URL before storage.
		expect(await getRawSetting(db, 'twitterUrl')).toBe('https://twitter.com/taro');
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
		expect(resolveAvatarUrl).toHaveBeenCalledWith({
			blueskyUrl: 'https://bsky.app/profile/sunday.bsky.social'
		});
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe(
			'https://cdn.bsky.app/img/avatar/plain/derived'
		);
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
