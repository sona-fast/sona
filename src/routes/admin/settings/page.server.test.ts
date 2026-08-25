import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';
import {
	getRawSetting,
	setRawSetting,
	parseLines,
	getSupporterKeyStatus,
	clearSupporterKeyStatusCache
} from '$lib/server/settings';
import { stickerTabEnabled, clearStickerTabCache } from '$lib/server/stickers';
import { MAX_SONA_COLORS } from '$lib/palette-merge';
import { DEFAULT_THEME_ID } from '$lib/themes';
import { DEFAULT_LANDING_LAYOUT } from '$lib/landing';
import { resolveAvatarUrl } from '$lib/server/avatar';
import { verifySupporterKey, supporterKeyDisplayRecord } from '$lib/server/supporter-key';
import { EARLY_ACCESS } from '$lib/early-access';
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
// supporter-key.test.ts with a real in-test keypair. The date formatting stays
// real so the formatted dates are exercised.
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
	return {
		sqlite,
		db: drizzle(d1, { schema }),
		platform: { env: { DB: d1 } } as unknown as App.Platform
	};
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
		// Capture each tag by name, then look inside it: attribute order and extra
		// attributes are harmless, the wrong type is not.
		const marker = src.match(/<input[^>]*\bname="aiPageEnabledPresent"[^>]*>/)?.[0] ?? '';
		expect(marker, 'present-marker input').toContain('type="hidden"');
		const toggle = src.match(/<input[^>]*\bname="aiPageEnabled"[^>]*>/)?.[0] ?? '';
		expect(toggle, 'toggle input').toContain('type="checkbox"');
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

// The rows this guards span three unrelated features (the /ai page, Telegram
// auto-resync, registry overrides), so it lives at the page level rather than
// inside any one feature's describe.
describe('settings — checkbox hints are described, not named (SONA-183)', () => {
	// Source pin (SONA-183): each checkbox hint lives OUTSIDE its <label> and
	// reaches the input through aria-describedby, so the accessible name stays
	// the short title instead of swallowing the whole description. Folding a hint
	// back into a label would restore the old behaviour with the suite still green.
	it('describes each checkbox from outside its label', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		for (const name of ['aiPageEnabled', 'autoResyncEnabled', 'registryOverridesLocal']) {
			// Capture the whole tag, then look inside it: attribute order and extra
			// attributes are harmless, a missing aria-describedby is not.
			const input = src.match(new RegExp(`<input[^>]*\\bname="${name}"[^>]*>`))?.[0] ?? '';
			expect(input, `${name} input`).toContain(`aria-describedby="${name}-desc"`);
			// `>[^<]*</label>` is the containment assertion: the title label holds text
			// and nothing else, so no hint can be folded back in to restore the
			// ~450-character accessible name with every id still pointing where it does.
			const title =
				src.match(new RegExp(`<label[^>]*\\bfor="${name}"[^>]*>[^<]*</label>`))?.[0] ?? '';
			expect(title, `${name} title label`).toMatch(/class="[^"]*\bcheckbox-title\b/);
			const desc = src.match(new RegExp(`<span[^>]*\\bid="${name}-desc"[^>]*>`))?.[0] ?? '';
			expect(desc, `${name} hint`).toMatch(/class="[^"]*\bcheckbox-desc\b/);
		}
		// The row is a <div>: a wrapping <label> would put every hint back inside
		// the accessible name no matter where the ids point.
		expect(src).not.toMatch(/<label[^>]*class="[^"]*\bcheckbox-row\b/);
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
	CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
	CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, global_id TEXT UNIQUE,
		registry_version INTEGER, registry_synced_at TEXT, aliases TEXT,
		avatar_resolved_at TEXT, created_at TEXT NOT NULL);`;

const LOAD_URL = new URL('https://taro.surf/admin/settings');

// The load and the supporter-key action render the expiry date and its countdown
// in the operator's zone, which hooks resolves onto locals (SONA-119). 'UTC' is
// what an absent or unusable cookie yields, and what the fixed-date assertions
// below expect.
function loadEvent(platform: App.Platform, tz = 'UTC') {
	return { platform, url: LOAD_URL, locals: { timeZone: tz } } as never;
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

describe('settings load — con card (SONA-115)', () => {
	type ConCard = {
		name: string;
		species: string;
		colors: Array<{ name: string; hex: string }>;
		handles: Array<{ platform: string; value: string }>;
		avatarSrc: string | null;
		artCredit: string | null;
		connectUrl: string;
		displayDomain: string;
	};

	async function conCard(db: ReturnType<typeof drizzle>, platform: App.Platform): Promise<ConCard> {
		const result = (await load(loadEvent(platform))) as unknown as { conCard: ConCard };
		return result.conCard;
	}

	/** A reference sheet by the given artist, resolved the same way /art does. */
	async function seedRefSheet(db: ReturnType<typeof drizzle>, artist: Record<string, string>) {
		const row = await db
			.insert(schema.artists)
			.values({ ...artist, createdAt: '2026-01-01' } as typeof schema.artists.$inferInsert)
			.returning({ id: schema.artists.id })
			.get();
		const img = await db
			.insert(schema.images)
			.values({
				title: 'ref',
				slug: 'ref',
				imageUrl: 'https://abc12.ufs.sh/f/key',
				artistId: row.id,
				createdAt: '2026-01-01'
			})
			.returning({ id: schema.images.id })
			.get();
		const tag = await db
			.insert(schema.tags)
			.values({ name: 'reference' })
			.returning({ id: schema.tags.id })
			.get();
		await db.insert(schema.imageTags).values({ imageId: img.id, tagId: tag.id });
	}

	it('points the QR at /connect, never at the /connect/qr scan target', async () => {
		const { db, platform } = makeLoadDb();

		const card = await conCard(db, platform);

		// A printed card outlives the app, and /connect is never gated.
		expect(card.connectUrl).toBe('https://taro.surf/connect');
		expect(card.connectUrl).not.toContain('/connect/qr');
	});

	it('prefers the configured canonical origin over the host the admin opened', async () => {
		const { db, platform } = makeLoadDb();
		// The request in loadEvent is https://taro.surf; the card must carry the
		// canonical domain instead, since it is printed once.
		await setRawSetting(db, 'siteUrl', 'https://taro.example/');

		const card = await conCard(db, platform);

		expect(card.connectUrl).toBe('https://taro.example/connect');
		expect(card.displayDomain).toBe('taro.example');
	});

	it('carries the sona profile, with the owner name winning over the site name', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'siteName', 'Taro Surf');
		await setRawSetting(db, 'ownerName', 'Taro');
		await setRawSetting(db, 'sonaSpecies', 'Red panda');
		await setRawSetting(db, 'sonaColors', JSON.stringify([{ name: 'Rust', hex: '#b45309' }]));

		const card = await conCard(db, platform);

		expect(card.name).toBe('Taro');
		expect(card.species).toBe('Red panda');
		expect(card.colors).toEqual([{ name: 'Rust', hex: '#b45309' }]);
	});

	it('offers every configured social, in card order', async () => {
		const { db, platform } = makeLoadDb();
		// All six socials the settings hold. Each draws its own mark on the card,
		// so none of them is worth withholding from the picker.
		await setRawSetting(db, 'blueskyUrl', 'https://bsky.app/profile/taro.surf');
		await setRawSetting(db, 'telegramUrl', 'https://t.me/taro_tg');
		await setRawSetting(db, 'twitterUrl', 'https://twitter.com/taro_x');
		await setRawSetting(db, 'furAffinityUrl', 'https://www.furaffinity.net/user/taro_fa');
		await setRawSetting(db, 'furtrackUrl', 'https://furtrack.com/user/taro_ft');
		await setRawSetting(db, 'instagramUrl', 'https://instagram.com/taro_ig');

		const card = await conCard(db, platform);

		// The platform id rather than its name: the card draws the platform as its
		// icon, and the settings UI resolves the name it shows from the same id.
		expect(card.handles).toEqual([
			{ platform: 'bluesky', value: '@taro.surf' },
			{ platform: 'telegram', value: '@taro_tg' },
			{ platform: 'twitter', value: '@taro_x' },
			{ platform: 'furaffinity', value: '@taro_fa' },
			{ platform: 'furtrack', value: '@taro_ft' },
			{ platform: 'instagram', value: '@taro_ig' }
		]);
	});

	it('drops a setting with no handle in it', async () => {
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'blueskyUrl', 'https://bsky.app/profile/taro.surf');
		// A bare platform URL carries no account (social-label rule 2). On a card
		// that row would tell a stranger nothing, so it must not be there at all.
		await setRawSetting(db, 'twitterUrl', 'https://twitter.com');
		await setRawSetting(db, 'furtrackUrl', 'https://furtrack.com');

		const card = await conCard(db, platform);

		expect(card.handles).toEqual([{ platform: 'bluesky', value: '@taro.surf' }]);
	});

	it('renders the card behind the early-access gate, on the Account tab', () => {
		// Source pin (the SONA-183 precedent above): the section is the only place
		// the con card is reachable, so an ungated {#if} would hand a supporter
		// feature to everyone with the whole suite still green.
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const section = src.slice(src.indexOf('{#if conCardEnabled}'));
		expect(section.slice(0, section.indexOf('{:else}'))).toContain('<ConCard');
		expect(src).toContain("isFeatureEnabled('con-card'");
		expect(src).toMatch(/<section class="security-section" data-tab="account">\s*\n\s*<h2>\{m\.admin_settings_con_card_heading\(\)\}/);
	});

	it('sends the persona avatar for the front, same-origin so the page can read it', async () => {
		const { db, platform } = makeLoadDb();
		// The front holds the persona's face, not the reference sheet: the card is
		// worn, and what a stranger matches against is a head.
		await setRawSetting(db, 'adminAvatarUrl', '/img/avatars/owner/face.jpg');

		expect((await conCard(db, platform)).avatarSrc).toBe('/img/avatars/owner/face.jpg');
	});

	it('leaves the avatar null when none is set, so the front falls back to an initial', async () => {
		const { db, platform } = makeLoadDb();

		expect((await conCard(db, platform)).avatarSrc).toBeNull();
	});

	it('routes a hotlinked avatar through the byte proxy, so the face still prints', async () => {
		const { db, platform } = makeLoadDb();
		// A hotlink we never re-hosted has no same-origin form, and the download
		// paths read the avatar's bytes through fetch, which connect-src confines
		// to our origin. Handing the card the raw URL is what used to put an
		// initial where the operator's face belongs — on a badge whose whole job
		// is letting someone confirm they met the right person.
		await setRawSetting(db, 'adminAvatarUrl', 'https://cdn.bsky.app/img/avatar/plain/x');

		expect((await conCard(db, platform)).avatarSrc).toBe('/api/admin/avatar');
	});

	it('proxies an avatar that only a crossorigin <img> could read', async () => {
		const { db, platform } = makeLoadDb();
		// storedImageSource answers for the ref-sheet picker, which loads through
		// an <img> and can set crossorigin. The card uses fetch, so that answer is
		// right for the picker and unreadable here. UploadThing serves
		// Access-Control-Allow-Origin: * and it makes no difference: CORS is not
		// what blocks this, connect-src is.
		await setRawSetting(db, 'adminAvatarUrl', 'https://utfs.io/f/abc123');

		expect((await conCard(db, platform)).avatarSrc).toBe('/api/admin/avatar');
	});

	it('credits the reference sheet by the artist handle when there is one', async () => {
		const { db, platform } = makeLoadDb();
		await seedRefSheet(db, { name: 'Nori', blueskyUrl: 'https://bsky.app/profile/nori.art' });

		expect((await conCard(db, platform)).artCredit).toBe('@nori.art');
	});

	it('falls back to the artist name, and to no credit at all without an artist', async () => {
		const withName = makeLoadDb();
		await seedRefSheet(withName.db, { name: 'Nori' });
		expect((await conCard(withName.db, withName.platform)).artCredit).toBe('Nori');

		const bare = makeLoadDb();
		expect((await conCard(bare.db, bare.platform)).artCredit).toBeNull();
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

	// Unchanged-handle guard (#187): the site tab posts bluesky on EVERY save, so
	// an unrelated save (a transient resolve failure included) must not degrade an
	// owned re-hosted copy — the refresh cron would heal it back, but a day later
	// and only from a hotlink, so don't create the damage. With the handle
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
		// storing a rot-prone hotlink for the owner is worse than clearing and
		// re-saving once storage recovers (the cron's heal is a slower backstop, not
		// a reason to store one).
		vi.mocked(resolveAvatarUrl).mockResolvedValueOnce(
			'https://cdn.bsky.app/img/avatar/plain/hotlink'
		);

		await actions.saveSite(saveSiteEvent(platform, { bluesky: 'new.bsky.social' }));

		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('');
	});

	// Load-bearing key ORDER, not a style choice: healOwnerAvatar (the refresh
	// cron) re-reads blueskyUrl alone right before it writes adminAvatarUrl, and
	// that single-key read is only a valid guard because a concurrent save has
	// necessarily written its handle first — saveSettings walks this object in
	// insertion order with no transaction. Swap the two keys and a save caught
	// mid-flight slips past the guard and loses its just-written avatar.
	it('writes blueskyUrl before adminAvatarUrl, which is what makes the cron heal guard safe', async () => {
		const { sqlite, platform } = makeDb();
		// Triggers, so the assertion is on the writes that actually reached D1
		// rather than on the shape of the source.
		sqlite.exec(`CREATE TABLE settings_writes (n INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL);
		CREATE TRIGGER log_settings_insert AFTER INSERT ON site_settings
		BEGIN INSERT INTO settings_writes (key) VALUES (NEW.key); END;
		CREATE TRIGGER log_settings_update AFTER UPDATE ON site_settings
		BEGIN INSERT INTO settings_writes (key) VALUES (NEW.key); END;`);

		await actions.saveSite(saveSiteEvent(platform, { bluesky: 'sunday.bsky.social' }));

		const keys: string[] = sqlite
			.prepare('SELECT key FROM settings_writes ORDER BY n')
			.all()
			.map((r: { key: string }) => r.key);
		expect(keys).toContain('blueskyUrl');
		expect(keys).toContain('adminAvatarUrl');
		expect(keys.indexOf('blueskyUrl')).toBeLessThan(keys.indexOf('adminAvatarUrl'));
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

function saveSupporterKeyEvent(platform: App.Platform, key: string, tz = 'UTC') {
	const body = new FormData();
	body.append('supporterKey', key);
	return {
		platform,
		locals: { timeZone: tz },
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

// The admin layout's expiry notice reads a memoized status (SONA-118). Both
// actions write the key row, so both must drop that memo — otherwise the notice
// keeps describing the previous key for up to a minute after the operator acted.
describe('supporter-key actions — invalidate the memoized status (SONA-118)', () => {
	// Unlike the other two suites this file has no file-level memo hook, and every
	// test here opens by priming the memo — so clear it on both sides.
	beforeEach(() => {
		clearSupporterKeyStatusCache();
	});

	afterEach(() => {
		// These stub verification for a whole test (not once), so undo both the
		// standing stub and the memo they primed.
		vi.mocked(verifySupporterKey).mockReset();
		clearSupporterKeyStatusCache();
	});

	it('saveSupporterKey makes the next status resolution see the new key', async () => {
		const { db, platform } = makeDb();
		const now = new Date();
		// Prime the memo while no key is stored.
		expect(await getSupporterKeyStatus(db, now, 'UTC')).toBeNull();

		vi.mocked(verifySupporterKey).mockResolvedValue({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: new Date(now.getTime() + 30 * 86_400_000)
		});
		await actions.saveSupporterKey(saveSupporterKeyEvent(platform, 'head.tail'));

		expect(await getSupporterKeyStatus(db, now, 'UTC')).toMatchObject({ state: 'valid' });
	});

	it('the settings page load reads past the memo rather than answering from it', async () => {
		// The page keeps its own read + verify so it can never render a transient D1
		// error as "no key" (decision of 2026-08-07). Prime the memo with "no key
		// stored", then store one: a page load switched over to the memo — the
		// tempting edit now that this file imports the cache helpers — would answer
		// from that stale null instead.
		const { db, platform } = makeLoadDb();
		const now = new Date();
		expect(await getSupporterKeyStatus(db, now, 'UTC')).toBeNull();

		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockResolvedValue({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: new Date(now.getTime() + 30 * 86_400_000)
		});

		const result = (await load(loadEvent(platform))) as unknown as {
			supporterKey: { state: string } | null;
		};

		expect(result.supporterKey).toMatchObject({ state: 'valid' });
	});

	it('removeSupporterKey makes the next status resolution see no key', async () => {
		const { db, platform } = makeDb();
		const now = new Date();
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockResolvedValue({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: new Date(now.getTime() + 30 * 86_400_000)
		});
		expect(await getSupporterKeyStatus(db, now, 'UTC')).toMatchObject({ state: 'valid' });

		await actions.removeSupporterKey(removeSupporterKeyEvent(platform));

		expect(await getSupporterKeyStatus(db, now, 'UTC')).toBeNull();
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

		// A synthetic in-window flag for this test only (restored in the finally),
		// with a GA date far enough out that the assertion below never turns into
		// a comparison of two empty lists as the shipped registry empties.
		EARLY_ACCESS['probe'] = { gaDate: '2999-01-01', label: () => 'Probe' };
		// Frozen inside the con-card window. earlyAccessActive is a comparison
		// against the wall clock, so on the real one this test goes red the morning
		// the flag GAs, which is the day it is least worth reading a red suite.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
		try {
			const result = (await load(loadEvent(platform))) as unknown as {
				supporterKey: { keyRecord: string; state: string; validUntil: string } | null;
				earlyAccess: unknown[];
				settings: Record<string, unknown>;
			};

			// Exact shape on purpose: any NEW field added to the payload must be
			// re-reviewed here before it rides to the client. 'head.tail' is under the
			// masking threshold, so it passes through — the mask itself is covered in
			// supporter-key.test.ts and the "never ships the full token" test below.
			expect(result.supporterKey).toEqual({
				keyRecord: 'head.tail',
				state: 'valid',
				validUntil: '2026.08.31',
				// UTC-pinned twin of validUntil; keys the dismissal cookie (SONA-119).
				dismissKey: '2026.08.31',
				// Reviewed for this guard: which half of the warning window the key is
				// in. Two values, derived from the expiry the payload already carries —
				// it tells the client nothing the token or the dates don't.
				dismissPhase: expect.stringMatching(/^(early|final)$/),
				daysRemaining: expect.any(Number),
				expiringSoon: expect.any(Boolean)
			});
			// Each flag inside its window surfaces as flag + display-formatted GA
			// date — and nothing else rides along (a NEW field in the mapping must
			// be re-reviewed here first).
			//
			// Reviewed for this guard: 'con-card' is the shipped registry's first
			// real entry (SONA-115), and its gaDate is now the shipping value
			// (merge date + 7) rather than the registration placeholder. The
			// clock above is frozen inside that window, so this stays true after
			// the date passes in the real world.
			expect(result.earlyAccess).toEqual([
				{ flag: 'con-card', gaDate: '2026.08.27' },
				{ flag: 'probe', gaDate: '2999.01.01' }
			]);
			// The token must never leak into the client-exposed SiteSettings.
			expect(result.settings.supporterKey).toBeUndefined();
		} finally {
			vi.useRealTimers();
			delete EARLY_ACCESS['probe'];
		}
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

	// Source pin: the card is the only thing that ever displayed the key, and the
	// unit tests above cover the load payload, not the rendered document. Rendering
	// it for real needs a key signed by the sona.fast issuer, which tests can't
	// have — so pin the template instead. Reintroducing any client-side truncation
	// means the full token is being shipped again.
	it('the settings card renders the server-made mask, not a token it truncates', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(src).toContain('data.supporterKey.keyRecord');
		expect(src).not.toMatch(/supporterKey\.token|truncateKey/);
	});

	it('ships the mask and never the stored token, anywhere in the payload', async () => {
		// The page used to send the whole signed key and truncate at render, which
		// put a working key in the SSR payload and the client bundle. Scanning the
		// SERIALIZED payload is the check that survives a refactor: any field that
		// carries the token back — under any name — fails here.
		const token = `${'a'.repeat(60)}.${'b'.repeat(86)}`;
		const { db, platform } = makeLoadDb();
		await setRawSetting(db, 'supporterKey', token);
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: new Date('2026-09-01T00:00:00Z')
		});

		const result = (await load(loadEvent(platform))) as unknown as {
			supporterKey: { keyRecord: string } | null;
		};

		expect(result.supporterKey?.keyRecord).toBe(supporterKeyDisplayRecord(token));
		expect(JSON.stringify(result)).not.toContain(token);
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

describe('settings load — storage breakdown (SONA-192)', () => {
	function stubBucket(pages: { key: string; size: number }[][]) {
		let calls = 0;
		return {
			list: vi.fn(async () => {
				const objects = pages[calls];
				calls += 1;
				return {
					objects,
					truncated: calls < pages.length,
					cursor: calls < pages.length ? String(calls) : undefined
				};
			})
		};
	}

	it('skips the bucket listing entirely on UploadThing (breakdown null, list never called)', async () => {
		const bucket = stubBucket([[]]);
		const { db, platform } = makeLoadDb({ IMAGES: bucket });
		await setRawSetting(db, 'storageProvider', 'uploadthing');

		const result = (await load(loadEvent(platform))) as unknown as { breakdown: unknown };

		expect(result.breakdown).toBeNull();
		expect(bucket.list).not.toHaveBeenCalled();
	});

	it('collects the paginated breakdown on R2 with matching totals', async () => {
		const bucket = stubBucket([
			[
				{ key: 'artwork/a.png', size: 100 },
				{ key: 'vr-media/clip.webm', size: 700 }
			],
			[{ key: 'stickers/p/s.webp', size: 10 }]
		]);
		const { db, platform } = makeLoadDb({ IMAGES: bucket });
		await setRawSetting(db, 'storageProvider', 'r2');

		const result = (await load(loadEvent(platform))) as unknown as {
			breakdown: {
				totalBytes: number;
				totalCount: number;
				kinds: Record<string, { bytes: number; count: number }>;
			} | null;
		};

		expect(bucket.list).toHaveBeenCalledTimes(2);
		expect(result.breakdown).toMatchObject({ totalBytes: 810, totalCount: 3 });
		expect(result.breakdown!.kinds.vrVideo).toEqual({ bytes: 700, count: 1 });
	});

	it('degrades to breakdown null (payload intact, no throw) when the R2 list rejects', async () => {
		const bucket = {
			list: vi.fn(async (): Promise<never> => {
				throw new Error('R2 down: artwork/some-object-key.png');
			})
		};
		const { db, platform } = makeLoadDb({ IMAGES: bucket });
		await setRawSetting(db, 'storageProvider', 'r2');
		// Seed the D1-backed fields the load resolves BEFORE the bucket listing:
		// the listing runs last (free-plan subrequest budget — see the loader
		// comment), so a listing failure must never cost these.
		await setRawSetting(db, 'adminEmail', 'recover@taro.surf');
		await setRawSetting(db, 'supporterKey', 'head.tail');
		vi.mocked(verifySupporterKey).mockResolvedValueOnce({
			valid: true,
			login: 'sparky',
			tier: 2,
			expiresAt: new Date('2026-09-01T00:00:00Z')
		});

		const result = (await load(loadEvent(platform))) as unknown as {
			breakdown: unknown;
			breakdownTooLarge: boolean;
			settings: Record<string, unknown>;
			imageCount: number;
			storageStatus: { r2: boolean };
			adminEmail: string;
			supporterKey: { state: string } | null;
			registryEnabled: boolean;
		};

		expect(result.breakdown).toBeNull();
		// A FAILED listing is not the too-large case — the page keys its two
		// R2 no-breakdown notes on this flag.
		expect(result.breakdownTooLarge).toBe(false);
		// The rest of the payload still rides — the tab keeps its aggregate bar,
		// and every D1-dependent field resolved before the listing failed.
		expect(result.settings.storageProvider).toBe('r2');
		expect(result.imageCount).toBe(0);
		expect(result.storageStatus.r2).toBe(true);
		expect(result.adminEmail).toBe('recover@taro.surf');
		expect(result.supporterKey).toMatchObject({ state: 'valid' });
		expect(result.registryEnabled).toBe(false);
		// Key-privacy invariant: an R2 error can echo an object key, and that
		// key must never ride anywhere in the page payload.
		expect(JSON.stringify(result)).not.toContain('some-object-key');
	});

	it('surfaces the too-large discriminant when the bucket outgrows the page cap', async () => {
		// Endlessly truncated: every page says there's more. The collector stops
		// at its cap and the loader maps that to breakdownTooLarge instead of a
		// breakdown (or a failure).
		let calls = 0;
		const bucket = {
			list: vi.fn(async () => {
				calls += 1;
				return {
					objects: [{ key: 'artwork/a.png', size: 1 }],
					truncated: true,
					cursor: String(calls)
				};
			})
		};
		const { db, platform } = makeLoadDb({ IMAGES: bucket });
		await setRawSetting(db, 'storageProvider', 'r2');

		const result = (await load(loadEvent(platform))) as unknown as {
			breakdown: unknown;
			breakdownTooLarge: boolean;
		};

		expect(result.breakdown).toBeNull();
		expect(result.breakdownTooLarge).toBe(true);
		// The cap still bounds the subrequests: exactly the default 20 pages.
		expect(bucket.list).toHaveBeenCalledTimes(20);
	});

	// Source pin (SONA-183 precedent): the three no-breakdown notes are branch-
	// keyed, and no unit render exercises them — swapping the messages (or
	// collapsing the branches) would leave the suite green while an R2 outage
	// reads as "R2 only" (or as "too many files") to a fork already ON R2.
	it('the no-breakdown notes are wired to the right branches', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const branches = src.match(
			/\{:else if data\.settings\.storageProvider === 'uploadthing'\}([\s\S]*?)\{:else if data\.breakdownTooLarge\}([\s\S]*?)\{:else\}([\s\S]*?)\{\/if\}/
		);
		expect(branches, 'uploadthing/too-large/else branch triple').not.toBeNull();
		// UploadThing: no per-prefix listing exists — the R2-only pointer.
		expect(branches![1]).toContain('m.admin_settings_breakdown_r2_only()');
		expect(branches![1]).not.toContain('m.admin_settings_breakdown_unavailable()');
		// R2, bucket past the page cap: the too-large note, not the outage one.
		expect(branches![2]).toContain('m.admin_settings_breakdown_too_large()');
		expect(branches![2]).not.toContain('m.admin_settings_breakdown_unavailable()');
		// R2 with no breakdown and not too large: the listing failed.
		expect(branches![3]).toContain('m.admin_settings_breakdown_unavailable()');
		expect(branches![3]).not.toContain('m.admin_settings_breakdown_too_large()');
	});

	// Source pin: the warning const and the worded percentage span must sit
	// BEFORE the {#if data.breakdown} bar split, not inside the breakdown
	// branch — re-gating them there would strip the worded suffix from the
	// fallback branch and leave a color-only signal (WCAG 1.4.1) with the
	// suite green.
	it('the usage warning is not gated on the breakdown', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const constIdx = src.indexOf('{@const warn = usageWarning(pct)}');
		const spanIdx = src.indexOf('class="storage-pct"');
		const barSplitIdx = src.indexOf('{#if data.breakdown}');
		expect(constIdx).toBeGreaterThan(-1);
		expect(spanIdx).toBeGreaterThan(-1);
		expect(barSplitIdx).toBeGreaterThan(-1);
		expect(constIdx).toBeLessThan(barSplitIdx);
		expect(spanIdx).toBeLessThan(barSplitIdx);
		// The span carries both the color classes and the worded suffixes.
		const span = src.slice(spanIdx, src.indexOf('</span>', spanIdx));
		expect(span).toContain('class:warning={warn ===');
		expect(span).toContain('class:danger={warn ===');
		expect(span).toContain('m.admin_settings_usage_near()');
		expect(span).toContain('m.admin_settings_usage_full()');
	});

	// Source pin: the Bucket files tile renders the raw count. A locale-aware
	// format (toLocaleString) diverges between SSR (workerd en-US) and the
	// client's browser locale — a hydration text mismatch — and disagrees with
	// the raw-count Files column.
	it('the Bucket files tile renders the raw count', () => {
		const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(src).toContain('{data.breakdown.totalCount}');
		expect(src).not.toContain('totalCount.toLocaleString');
	});

	it('degrades to breakdown null when the listing never settles (5s deadline)', async () => {
		vi.useFakeTimers();
		try {
			// A bucket whose list() hangs forever — only the deadline can win.
			const bucket = { list: vi.fn(() => new Promise<never>(() => {})) };
			const { db, platform } = makeLoadDb({ IMAGES: bucket });
			await setRawSetting(db, 'storageProvider', 'r2');

			const pending = load(loadEvent(platform)) as Promise<{
				breakdown: unknown;
				settings: Record<string, unknown>;
				storageStatus: { r2: boolean };
			}>;
			await vi.advanceTimersByTimeAsync(5000);
			const result = await pending;

			expect(result.breakdown).toBeNull();
			expect(result.settings.storageProvider).toBe('r2');
			expect(result.storageStatus.r2).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
