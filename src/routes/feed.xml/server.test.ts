import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import {
	images,
	artists,
	stickerPacks,
	vrAvatars,
	fursuitPhotos,
	siteSettings
} from '$lib/server/db/schema';
import { clearSettingsCache } from '$lib/server/settings';
import { makeD1 } from '$lib/server/test/d1';
import { RTA_LABEL } from '$lib/server/feed';
import { GET } from './+server';

const ORIGIN = 'https://taro.surf';
/** A key of the shape the route actually mints (32 hex chars). */
const KEY = 'f'.repeat(32);

function makeDb(env: Record<string, string> = {}) {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
			bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT, patreon_url TEXT,
			instagram_url TEXT, global_id TEXT, registry_version INTEGER, registry_synced_at TEXT,
			aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, slug TEXT, image_url TEXT NOT NULL,
			thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER, md5hash TEXT,
			nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1, source_post_url TEXT,
			artist_id INTEGER, collection_id INTEGER, commissioned_at TEXT, parent_image_id INTEGER,
			variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER,
			created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE sticker_packs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL,
			description TEXT, cover_image_url TEXT, character_id INTEGER, manager_artist_id INTEGER,
			telegram_url TEXT, source TEXT NOT NULL DEFAULT 'telegram',
			published INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE vr_avatars (
			id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, name TEXT NOT NULL,
			character_id INTEGER, model_url TEXT, model_format TEXT, model_size_bytes INTEGER,
			poster_image_id INTEGER, external_url TEXT, license TEXT, permission_source TEXT,
			downloadable INTEGER NOT NULL DEFAULT 0, nsfw INTEGER NOT NULL DEFAULT 0,
			published INTEGER NOT NULL DEFAULT 1, description TEXT, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE fursuit_photos (
			id INTEGER PRIMARY KEY AUTOINCREMENT, furtrack_post_id INTEGER, character TEXT NOT NULL,
			description TEXT, image_url TEXT NOT NULL, width INTEGER, height INTEGER,
			photographer TEXT NOT NULL, photographer_url TEXT, event TEXT, license TEXT NOT NULL,
			permission_source TEXT, furtrack_url TEXT NOT NULL, taken_at TEXT,
			created_at TEXT NOT NULL DEFAULT ''
		);
	`);
	const d1 = makeD1(sqlite);
	return {
		db: drizzle(d1, { schema }),
		platform: { env: { DB: d1, ...env } } as unknown as App.Platform,
		// Exposed for the one test that has to break the database itself.
		sqlite: sqlite as { exec(sql: string): void }
	};
}

type Db = ReturnType<typeof makeDb>['db'];

const addArtist = (db: Db) => db.insert(artists).values({ id: 1, name: 'Artist' });

const addImage = (db: Db, overrides: Partial<typeof images.$inferInsert> = {}) =>
	db.insert(images).values({
		title: 'Parent Piece',
		slug: 'parent-piece',
		imageUrl: 'https://cdn.example.com/parent.png',
		artistId: 1,
		published: true,
		createdAt: '2026-07-01T00:00:00.000Z',
		...overrides
	});

const addPack = (db: Db, overrides: Partial<typeof stickerPacks.$inferInsert> = {}) =>
	db.insert(stickerPacks).values({
		name: 'Taro Pack',
		slug: 'taro-pack',
		description: 'A pack of stickers.',
		coverImageUrl: 'https://cdn.example.com/pack.png',
		characterId: 1,
		source: 'telegram',
		published: true,
		createdAt: '2026-07-02T00:00:00.000Z',
		...overrides
	});

const addAvatar = (db: Db, overrides: Partial<typeof vrAvatars.$inferInsert> = {}) =>
	db.insert(vrAvatars).values({
		slug: 'taro-vr',
		name: 'Taro VR',
		characterId: 1,
		description: 'A 3D avatar.',
		published: true,
		createdAt: '2026-07-03T00:00:00.000Z',
		...overrides
	});

const addPhoto = (db: Db, overrides: Partial<typeof fursuitPhotos.$inferInsert> = {}) =>
	db.insert(fursuitPhotos).values({
		furtrackPostId: 1,
		character: 'Taro',
		imageUrl: 'https://cdn.example.com/suit.jpg',
		photographer: 'Photographer',
		license: 'cc-by',
		furtrackUrl: 'https://furtrack.com/p/1',
		createdAt: '2026-07-04T00:00:00.000Z',
		...overrides
	});

const setSetting = (db: Db, key: string, value: string) =>
	db.insert(siteSettings).values({ key, value });

/** Call GET the way the router would. Returns the status, headers and body text
 * (empty on a 304, which carries none). */
async function call(
	platform: App.Platform,
	{ key, ifNoneMatch }: { key?: string; ifNoneMatch?: string } = {}
) {
	const url = new URL(`${ORIGIN}/feed.xml`);
	if (key !== undefined) url.searchParams.set('key', key);
	const request = new Request(url, {
		headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}
	});
	try {
		const res = (await GET({ url, request, platform } as never)) as Response;
		return { status: res.status, headers: res.headers, body: await res.text() };
	} catch (e) {
		return { status: (e as { status: number }).status, headers: new Headers(), body: '' };
	}
}

/** The <title> texts of the document's items, in order. */
function itemTitles(body: string): string[] {
	return [...body.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((m) => m[1]);
}

beforeEach(() => clearSettingsCache());

describe('GET /feed.xml — the master toggle', () => {
	it('serves the feed when nothing is stored (absent means on)', async () => {
		const { db, platform } = makeDb();
		await addArtist(db);
		await addImage(db);

		const res = await call(platform);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
		expect(itemTitles(res.body)).toContain('Parent Piece');
	});

	it("404s when the owner turned the feed off — the same not-found a missing path gets", async () => {
		const { db, platform } = makeDb();
		await addArtist(db);
		await addImage(db);
		await setSetting(db, 'rssFeedEnabled', 'false');

		expect((await call(platform)).status).toBe(404);
	});

	it('404s a keyed request too when the feed is off', async () => {
		// The NSFW key is not a bypass: the master toggle gates both editions.
		const { db, platform } = makeDb();
		await addImage(db, { nsfw: true });
		await setSetting(db, 'rssFeedEnabled', 'false');
		await setSetting(db, 'rssNsfwEnabled', 'true');
		await setSetting(db, 'rssNsfwKey', KEY);

		expect((await call(platform, { key: KEY })).status).toBe(404);
	});

	it('404s (fails closed) when the settings read throws', async () => {
		// getSettings swallows D1 errors and returns DEFAULTS, where the feed is
		// default-ON — so a gate reading through it would publish the feed for an
		// owner who turned it off. The raw read must 404 instead. An absent
		// site_settings table is the read failure a mid-deploy fork actually hits.
		const { db, platform, sqlite } = makeDb();
		await addArtist(db);
		await addImage(db);
		sqlite.exec('DROP TABLE site_settings');

		expect((await call(platform)).status).toBe(404);
	});
});

describe('GET /feed.xml — what it publishes', () => {
	it('covers all four sections, merged newest first', async () => {
		const { db, platform } = makeDb({ FURTRACK_MODE: 'mock' });
		await addArtist(db);
		await addImage(db);
		await addPack(db);
		await addAvatar(db);
		await addPhoto(db);

		const { body } = await call(platform);
		// created_at descending: photo (07-04), avatar (07-03), pack (07-02), art (07-01).
		expect(itemTitles(body)).toEqual([
			'Taro by Photographer',
			'Taro VR',
			'Taro Pack',
			'Parent Piece'
		]);
	});

	it('links each section at the route its detail page lives on', async () => {
		const { db, platform } = makeDb({ FURTRACK_MODE: 'mock' });
		await addArtist(db);
		await addImage(db);
		await addPack(db);
		await addAvatar(db);
		await addPhoto(db, { id: 7 });

		const { body } = await call(platform);
		expect(body).toContain(`<link>${ORIGIN}/gallery/parent-piece</link>`);
		expect(body).toContain(`<link>${ORIGIN}/stickers/taro-pack</link>`);
		expect(body).toContain(`<link>${ORIGIN}/vr/taro-vr</link>`);
		expect(body).toContain(`<link>${ORIGIN}/gallery/fursuit/7</link>`);
	});

	it('credits the artist on an art entry', async () => {
		const { db, platform } = makeDb();
		await addArtist(db);
		await addImage(db);

		const { body } = await call(platform);
		expect(body).toContain('<dc:creator>Artist</dc:creator>');
		expect(body).toContain('<media:credit>Artist</media:credit>');
	});

	it('advertises an absolute image URL', async () => {
		// A feed reader has no page to resolve a relative src against.
		const { db, platform } = makeDb();
		await addArtist(db);
		await addImage(db, { imageUrl: '/img/parent.png' });

		const { body } = await call(platform);
		const url = body.match(/<media:content url="([^"]+)"/)?.[1];
		expect(url).toBeTruthy();
		expect(new URL(url!).host).toBe('taro.surf');
	});

	it('prefers the thumbnail over the full-size image', async () => {
		const { db, platform } = makeDb();
		await addArtist(db);
		await addImage(db, { thumbnailUrl: 'https://cdn.example.com/thumb.png' });

		const { body } = await call(platform);
		expect(body).toContain('thumb.png');
		expect(body).not.toContain('parent.png');
	});

	it('lists ONE entry per sticker pack, never per sticker', async () => {
		// A 60-sticker import would otherwise bury every other section.
		const { db, platform } = makeDb();
		await addPack(db);

		expect(itemTitles((await call(platform)).body)).toEqual(['Taro Pack']);
	});
});

describe('GET /feed.xml — rows it must never publish', () => {
	it('omits unpublished rows from every section', async () => {
		const { db, platform } = makeDb({ FURTRACK_MODE: 'mock' });
		await addArtist(db);
		await addImage(db, { slug: 'draft-art', title: 'Draft Art', published: false });
		await addPack(db, { slug: 'draft-pack', name: 'Draft Pack', published: false });
		await addAvatar(db, { slug: 'draft-vr', name: 'Draft VR', published: false });

		expect(itemTitles((await call(platform)).body)).toEqual([]);
	});

	it('omits variants, which are the same artwork under a near-identical title', async () => {
		const { db, platform } = makeDb();
		await addArtist(db);
		await addImage(db, { id: 1 });
		await addImage(db, {
			id: 2,
			title: 'Parent Piece (alt)',
			slug: 'parent-piece-alt',
			parentImageId: 1,
			variantLabel: 'alt'
		});

		expect(itemTitles((await call(platform)).body)).toEqual(['Parent Piece']);
	});

	it('omits a fursuit photo whose license does not permit reposting', async () => {
		const { db, platform } = makeDb({ FURTRACK_MODE: 'mock' });
		await addPhoto(db, { furtrackPostId: 2, character: 'Hidden', license: 'all-rights-reserved' });

		expect(itemTitles((await call(platform)).body)).toEqual([]);
	});

	it('publishes a non-displayable photo when permission was recorded', async () => {
		// The detail page's own predicate: license OR a recorded permission.
		const { db, platform } = makeDb({ FURTRACK_MODE: 'mock' });
		await addPhoto(db, {
			furtrackPostId: 3,
			character: 'Allowed',
			license: 'all-rights-reserved',
			permissionSource: 'Telegram DM 2026-05-29'
		});

		expect(itemTitles((await call(platform)).body)).toEqual(['Allowed by Photographer']);
	});

	it('omits every fursuit photo when FURTRACK_MODE is off', async () => {
		// The feature is off site-wide; the feed must not be the one surface that
		// keeps publishing stored rows.
		const { db, platform } = makeDb();
		await addPhoto(db);

		expect(itemTitles((await call(platform)).body)).toEqual([]);
	});
});

describe('GET /feed.xml — the NSFW gate', () => {
	/** A site with one SFW and one NSFW piece, plus an avatar whose poster is
	 * adult (the effective-flag case). */
	async function nsfwSite(opts: { enabled?: boolean; key?: string } = {}) {
		const { db, platform } = makeDb();
		await addArtist(db);
		await addImage(db, { id: 1, title: 'Tame', slug: 'tame' });
		await addImage(db, {
			id: 2,
			title: 'Spicy',
			slug: 'spicy',
			nsfw: true,
			createdAt: '2026-07-05T00:00:00.000Z'
		});
		await addImage(db, {
			id: 3,
			title: 'Poster',
			slug: 'poster',
			nsfw: true,
			published: false,
			createdAt: '2026-06-01T00:00:00.000Z'
		});
		await addAvatar(db, { posterImageId: 3, createdAt: '2026-07-06T00:00:00.000Z' });
		if (opts.enabled) await setSetting(db, 'rssNsfwEnabled', 'true');
		if (opts.key) await setSetting(db, 'rssNsfwKey', opts.key);
		return platform;
	}

	it('omits NSFW work from the public feed', async () => {
		const platform = await nsfwSite({ enabled: true, key: KEY });

		const { body } = await call(platform);
		expect(itemTitles(body)).toEqual(['Tame']);
		// A title is content too — an omitted entry leaves nothing behind.
		expect(body).not.toContain('Spicy');
		expect(body).not.toContain(RTA_LABEL);
		expect(body).not.toContain('<category>NSFW</category>');
		expect(body).not.toContain('[NSFW]');
	});

	it('serves adult work, marked in band, to the right key', async () => {
		const platform = await nsfwSite({ enabled: true, key: KEY });

		const { status, headers, body } = await call(platform, { key: KEY });
		expect(status).toBe(200);
		expect(itemTitles(body)).toEqual(['[NSFW] Taro VR', '[NSFW] Spicy', 'Tame']);
		expect(body).toContain(`<rating>${RTA_LABEL}</rating>`);
		expect(body).toContain('<category>NSFW</category>');
		expect(headers.get('x-robots-tag')).toBe('noindex');
	});

	it('treats an avatar with an adult poster as adult', async () => {
		// Matches /vr's loader: a SFW avatar with an adult poster is adult as far
		// as anything that renders the poster is concerned.
		const platform = await nsfwSite({ enabled: true, key: KEY });

		// Absent from the public feed, and marked (not merely present) on the keyed
		// one — the avatar row's own nsfw column is false, so an implementation
		// that read only that column would list it unmarked.
		expect((await call(platform)).body).not.toContain('Taro VR');
		expect(itemTitles((await call(platform, { key: KEY })).body)).toContain('[NSFW] Taro VR');
	});

	it.each([
		{ name: 'a wrong key', key: 'a'.repeat(32) },
		{ name: 'an empty key', key: '' },
		{ name: 'a truncated prefix of the real key', key: KEY.slice(0, 31) }
	])('answers $name with the ordinary SFW document, never an error', async ({ key }) => {
		// A 403 would confirm that a key exists to be guessed at, so a bad key is
		// answered byte-for-byte as an anonymous request would be.
		const platform = await nsfwSite({ enabled: true, key: KEY });

		const anonymous = await call(platform);
		const wrong = await call(platform, { key });
		expect(wrong.status).toBe(200);
		expect(itemTitles(wrong.body)).toEqual(['Tame']);
		expect(wrong.headers.get('x-robots-tag')).toBeNull();
		// Identical but for atom:link rel=self, which necessarily echoes the query.
		expect(wrong.body.replace(/<atom:link[^>]*\/>/, '')).toBe(
			anonymous.body.replace(/<atom:link[^>]*\/>/, '')
		);
	});

	it('serves the SFW document to the right key while the NSFW setting is off', async () => {
		// Off is a hard gate: with no opt-in there is no address that returns adult
		// work, whatever key is presented.
		const platform = await nsfwSite({ key: KEY });

		const { status, body } = await call(platform, { key: KEY });
		expect(status).toBe(200);
		expect(itemTitles(body)).toEqual(['Tame']);
		expect(body).not.toContain(RTA_LABEL);
	});

	it('cannot be unlocked before a key is minted', async () => {
		const platform = await nsfwSite({ enabled: true });

		expect(itemTitles((await call(platform, { key: '' })).body)).toEqual(['Tame']);
	});
});

describe('GET /feed.xml — caching', () => {
	it('answers a matching If-None-Match with 304 and no body', async () => {
		const { db, platform } = makeDb();
		await addArtist(db);
		await addImage(db);

		const first = await call(platform);
		const etag = first.headers.get('etag');
		expect(etag).toMatch(/^"[0-9a-f]{16}"$/);

		const second = await call(platform, { ifNoneMatch: etag! });
		expect(second.status).toBe(304);
		expect(second.body).toBe('');
		expect(second.headers.get('etag')).toBe(etag);
	});

	it('changes the etag when the content changes', async () => {
		const { db, platform } = makeDb();
		await addArtist(db);
		await addImage(db);
		const before = (await call(platform)).headers.get('etag');

		await addImage(db, { id: 2, title: 'Newer', slug: 'newer', createdAt: '2026-08-01T00:00:00.000Z' });
		clearSettingsCache();
		expect((await call(platform)).headers.get('etag')).not.toBe(before);
	});

	it('serves a stale validator as a normal 200', async () => {
		const { db, platform } = makeDb();
		await addArtist(db);
		await addImage(db);

		const res = await call(platform, { ifNoneMatch: '"0000000000000000"' });
		expect(res.status).toBe(200);
		expect(res.body).toContain('Parent Piece');
	});

	it('carries a short, revocation-friendly Cache-Control', async () => {
		const { platform } = makeDb();
		expect((await call(platform)).headers.get('cache-control')).toBe(
			'public, max-age=60, s-maxage=300'
		);
	});
});
