import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { images, artists } from '$lib/server/db/schema';
import { clearSettingsCache } from '$lib/server/settings';
import { makeD1 } from '$lib/server/test/d1';
import { socialImageUrl, socialImageDimensions } from '$lib/social-image';
import { GET } from './+server';

const ORIGIN = 'https://taro.surf';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
			bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT, patreon_url TEXT,
			instagram_url TEXT, global_id TEXT, registry_version INTEGER, registry_synced_at TEXT, aliases TEXT, avatar_resolved_at TEXT,
			created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, slug TEXT, image_url TEXT NOT NULL,
			thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER, md5hash TEXT,
			nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1, source_post_url TEXT,
			artist_id INTEGER, collection_id INTEGER, commissioned_at TEXT, parent_image_id INTEGER,
			variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER,
			created_at TEXT NOT NULL DEFAULT ''
		);
	`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

/** Call GET the way the router would, with `target` as the raw ?url= value. */
async function call(platform: App.Platform, target?: string) {
	const url = new URL(`${ORIGIN}/api/oembed`);
	if (target !== undefined) url.searchParams.set('url', target);
	try {
		const res = (await GET({ url, platform } as never)) as Response;
		return { status: res.status, body: await res.json() };
	} catch (e) {
		return { status: (e as { status: number }).status, body: null };
	}
}

/** Same as call(), but for a ?url= value that must NOT be re-encoded. */
async function callRaw(platform: App.Platform, rawQuery: string) {
	const url = new URL(`${ORIGIN}/api/oembed?url=${rawQuery}`);
	try {
		const res = (await GET({ url, platform } as never)) as Response;
		return { status: res.status, body: await res.json() };
	} catch (e) {
		return { status: (e as { status: number }).status, body: null };
	}
}

beforeEach(() => clearSettingsCache());

describe('GET /api/oembed — anonymous provider endpoint', () => {
	it('answers 200 with a valid oEmbed photo payload for a published slug', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist', blueskyUrl: 'https://bsky.app/a' });
		await db.insert(images).values({
			id: 1, title: 'Parent Piece', slug: 'parent-piece', imageUrl: '/img/parent.png',
			width: 900, height: 700, artistId: 1, published: true, createdAt: '2026-07-01T00:00:00.000Z'
		});

		const { status, body } = await call(platform, `${ORIGIN}/gallery/parent-piece`);
		expect(status).toBe(200);
		expect(body).toMatchObject({
			version: '1.0',
			type: 'photo',
			title: 'Parent Piece',
			author_name: 'Commission by Artist',
			author_url: 'https://bsky.app/a',
			provider_url: ORIGIN
		});
	});

	it('resolves a variant slug too (docs/image-variants.md — variants are embeddable)', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({
			id: 1, title: 'Parent Piece', slug: 'parent-piece', imageUrl: '/img/parent.png',
			width: 900, height: 700, artistId: 1, published: true, createdAt: '2026-07-01T00:00:00.000Z'
		});
		await db.insert(images).values({
			id: 2, title: 'Variant Piece', slug: 'variant-piece', imageUrl: '/img/variant.png',
			width: 900, height: 700, artistId: 1, published: true, parentImageId: 1,
			variantLabel: 'Alt', createdAt: '2026-07-02T00:00:00.000Z'
		});

		const { status, body } = await call(platform, `${ORIGIN}/gallery/variant-piece`);
		expect(status).toBe(200);
		expect((body as { title: string }).title).toBe('Variant Piece');
	});

	it('404s an unpublished row (the gate is here, not in the hook)', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values({
			id: 4, title: 'Draft', slug: 'mature-poster-source', imageUrl: '/img/draft.png',
			width: 900, height: 700, artistId: 1, published: false, createdAt: '2026-07-04T00:00:00.000Z'
		});

		expect((await call(platform, `${ORIGIN}/gallery/mature-poster-source`)).status).toBe(404);
	});

	it('400s a missing url param', async () => {
		const { platform } = makeDb();
		expect((await call(platform)).status).toBe(400);
	});

	it('400s an unparseable url', async () => {
		const { platform } = makeDb();
		expect((await call(platform, 'not-a-url')).status).toBe(400);
	});

	it('400s (not 500s) a malformed percent-escape in the path', async () => {
		// decodeURIComponent throws URIError on a truncated escape — an anonymous
		// caller must not be able to turn that into a 500.
		const { platform } = makeDb();
		const res = await callRaw(
			platform,
			encodeURIComponent(`${ORIGIN}/gallery/`) + '%25E0%25A4%25A'
		);
		expect(res.status).toBe(400);
	});

	it('404s a url on a foreign host (no unfurling other sites under our name)', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values({
			id: 1, title: 'Parent Piece', slug: 'parent-piece', imageUrl: '/img/parent.png',
			width: 900, height: 700, artistId: 1, published: true, createdAt: '2026-07-01T00:00:00.000Z'
		});

		expect((await call(platform, 'https://evil.test/gallery/parent-piece')).status).toBe(404);
	});

	it('still answers when the artist join is empty (author_name falls back)', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values({
			id: 1, title: 'Orphan', slug: 'orphan', imageUrl: '/img/orphan.png',
			width: 900, height: 700, artistId: 99, published: true, createdAt: '2026-07-01T00:00:00.000Z'
		});

		const { status, body } = await call(platform, `${ORIGIN}/gallery/orphan`);
		expect(status).toBe(200);
		expect(body).toMatchObject({
			author_name: 'Commission',
			author_url: `${ORIGIN}/gallery/orphan`
		});
	});
});

describe('GET /api/oembed — the image it advertises', () => {
	it('returns an absolute, CDN-capped url with dimensions capped to match', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values({
			id: 1, title: 'Big', slug: 'big', imageUrl: '/img/big.png',
			width: 2400, height: 1800, artistId: 1, published: true, createdAt: '2026-07-01T00:00:00.000Z'
		});

		const { body } = await call(platform, `${ORIGIN}/gallery/big`);
		const payload = body as { url: string; width: number; height: number };
		// A third-party embedder can only fetch an absolute URL.
		expect(new URL(payload.url).host).toBe('taro.surf');
		expect(payload.url).toContain('/cdn-cgi/image/width=1200');
		// ...and the dimensions describe THAT image, not the 2400px original.
		expect(payload.width).toBe(1200);
		expect(payload.height).toBe(900);
	});

	it('matches what Meta.svelte advertises as og:image (one shared helper, no drift)', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values({
			id: 1, title: 'Big', slug: 'big', imageUrl: '/img/big.png',
			width: 2400, height: 1800, artistId: 1, published: true, createdAt: '2026-07-01T00:00:00.000Z'
		});

		const { body } = await call(platform, `${ORIGIN}/gallery/big`);
		const payload = body as { url: string; width: number; height: number };
		// The same helper Meta.svelte renders og:image/og:image:width from.
		expect(payload.url).toBe(socialImageUrl('/img/big.png', `${ORIGIN}/gallery/big`));
		expect({ width: payload.width, height: payload.height }).toEqual(
			socialImageDimensions(2400, 1800)
		);
	});
});
