import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { characters, images, artists, tags, imageTags, siteSettings } from '$lib/server/db/schema';
import { clearSettingsCache } from '$lib/server/settings';
import { load } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

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
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
		CREATE TABLE characters (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
			is_owner INTEGER NOT NULL DEFAULT 0, reference_image_id INTEGER, created_at TEXT NOT NULL DEFAULT ''
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

beforeEach(() => clearSettingsCache());

describe('art load — refSheet precedence', () => {
	it('prefers the explicit designation over a newer tagged image', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		// Designated (older) image, not tagged.
		await db.insert(images).values({ id: 5, title: 'Ref', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' });
		// Newer image tagged 'reference' — would win the tag query.
		await db.insert(images).values({ id: 6, title: 'Tagged', slug: 'art-6', imageUrl: 'https://cdn.example.com/6.png', artistId: 1, published: true, createdAt: '2026-06-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 6, tagId: 1 });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		const data = (await load({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(data.refSheet?.slug).toBe('art-5');
	});

	it('falls back to the tagged image when no designation is set', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values({ id: 6, title: 'Tagged', slug: 'art-6', imageUrl: 'https://cdn.example.com/6.png', artistId: 1, published: true, createdAt: '2026-06-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 6, tagId: 1 });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: null });

		const data = (await load({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(data.refSheet?.slug).toBe('art-6');
	});

	it('falls back to the tagged image when the designated image is unpublished', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values({ id: 5, title: 'Ref', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1, published: false, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(images).values({ id: 6, title: 'Tagged', slug: 'art-6', imageUrl: 'https://cdn.example.com/6.png', artistId: 1, published: true, createdAt: '2026-06-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 6, tagId: 1 });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		const data = (await load({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(data.refSheet?.slug).toBe('art-6');
	});

	// The ref sheet is /art's LCP element; the load must carry intrinsic
	// width/height so the template can reserve its box (no CLS).
	it('returns intrinsic width/height via the designated path', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({ id: 5, title: 'Ref', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', width: 1200, height: 1600, artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		const data = (await load({ platform } as never)) as { refSheet: { width: number; height: number } | null };
		expect(data.refSheet).toMatchObject({ width: 1200, height: 1600 });
	});

	it('returns intrinsic width/height via the tagged-fallback path', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values({ id: 6, title: 'Tagged', slug: 'art-6', imageUrl: 'https://cdn.example.com/6.png', width: 900, height: 1200, artistId: 1, published: true, createdAt: '2026-06-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 6, tagId: 1 });

		const data = (await load({ platform } as never)) as { refSheet: { width: number; height: number } | null };
		expect(data.refSheet).toMatchObject({ width: 900, height: 1200 });
	});
});

// SONA-18: the operator's designation (and the reference-tag fallback) is
// honored for NSFW images — the load returns the row and carries the flag so
// the page can shield it — while variants are excluded from both paths.
describe('art load — refSheet NSFW flag and variant exclusion (SONA-18)', () => {
	type RefSheet = { slug: string; nsfw: boolean } | null;

	async function loadRefSheet(platform: App.Platform) {
		return ((await load({ platform } as never)) as { refSheet: RefSheet }).refSheet;
	}

	it('returns an NSFW designated image, flagged so the page can shield it', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({ id: 5, title: 'Ref', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1, published: true, nsfw: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		expect(await loadRefSheet(platform)).toMatchObject({ slug: 'art-5', nsfw: true });
	});

	it('returns an NSFW tagged image, flagged, via the fallback path', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values({ id: 6, title: 'Tagged', slug: 'art-6', imageUrl: 'https://cdn.example.com/6.png', artistId: 1, published: true, nsfw: true, createdAt: '2026-06-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 6, tagId: 1 });

		expect(await loadRefSheet(platform)).toMatchObject({ slug: 'art-6', nsfw: true });
	});

	it('flags an SFW ref sheet false — the shield stays off', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({ id: 5, title: 'Ref', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		expect(await loadRefSheet(platform)).toMatchObject({ slug: 'art-5', nsfw: false });
	});

	it('falls back to the tagged image when a variant is designated', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values([
			{ id: 5, title: 'Parent', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' },
			// A variant of 5 — designatable from the edit page, never a standalone card.
			{ id: 7, title: 'Variant', slug: 'art-7', imageUrl: 'https://cdn.example.com/7.png', artistId: 1, published: true, parentImageId: 5, variantLabel: 'Alt', createdAt: '2026-02-01T00:00:00.000Z' },
			{ id: 6, title: 'Tagged', slug: 'art-6', imageUrl: 'https://cdn.example.com/6.png', artistId: 1, published: true, createdAt: '2026-06-01T00:00:00.000Z' }
		]);
		await db.insert(imageTags).values({ imageId: 6, tagId: 1 });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 7 });

		expect(await loadRefSheet(platform)).toMatchObject({ slug: 'art-6' });
	});

	it('skips a tagged variant in favor of an older tagged parent', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values([
			{ id: 5, title: 'Parent', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' },
			// Newer, so it would win the tag query's createdAt DESC ordering.
			{ id: 7, title: 'Variant', slug: 'art-7', imageUrl: 'https://cdn.example.com/7.png', artistId: 1, published: true, parentImageId: 5, variantLabel: 'Alt', createdAt: '2026-06-01T00:00:00.000Z' }
		]);
		await db.insert(imageTags).values([{ imageId: 5, tagId: 1 }, { imageId: 7, tagId: 1 }]);

		expect(await loadRefSheet(platform)).toMatchObject({ slug: 'art-5' });
	});

	it('has no ref sheet at all when the only candidate is a variant', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values([
			{ id: 5, title: 'Parent', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1, published: false, createdAt: '2026-01-01T00:00:00.000Z' },
			{ id: 7, title: 'Variant', slug: 'art-7', imageUrl: 'https://cdn.example.com/7.png', artistId: 1, published: true, parentImageId: 5, variantLabel: 'Alt', createdAt: '2026-06-01T00:00:00.000Z' }
		]);
		await db.insert(imageTags).values({ imageId: 7, tagId: 1 });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 7 });

		// The variant is still published art, so the page itself stays reachable
		// through recentArt — only the ref-sheet slot is empty.
		expect(await loadRefSheet(platform)).toBeNull();
	});
});

describe('art load — content-presence gate (#42)', () => {
	it('404s when every content source is absent', async () => {
		const { platform } = makeDb();
		await expect(load({ platform } as never)).rejects.toMatchObject({ status: 404 });
	});

	it('loads with only a reference-tagged image', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values({ id: 1, title: 'Ref', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, nsfw: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 1, tagId: 1 });

		const data = (await load({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(data.refSheet?.slug).toBe('art-1');
	});

	it('loads with only an explicitly designated reference image', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({ id: 1, title: 'Ref', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, nsfw: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 1 });

		const data = (await load({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(data.refSheet?.slug).toBe('art-1');
	});

	it('loads with only recent art (published, untagged)', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({ id: 1, title: 'Art', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' });

		const data = (await load({ platform } as never)) as { recentArt: unknown[] };
		expect(data.recentArt).toHaveLength(1);
	});

	it('loads with only sheet details (species setting)', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'sonaSpecies', value: 'Dragon' });

		const data = (await load({ platform } as never)) as { sona: { species: string } };
		expect(data.sona.species).toBe('Dragon');
	});

	it('loads with only color swatches', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'sonaColors', value: '[{"name":"Fur","hex":"#aabbcc"}]' });

		const data = (await load({ platform } as never)) as { sona: { colors: unknown[] } };
		expect(data.sona.colors).toHaveLength(1);
	});

	it('loads with only a build setting', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'sonaBuild', value: 'Stocky' });

		const data = (await load({ platform } as never)) as { sona: { build: string } };
		expect(data.sona.build).toBe('Stocky');
	});

	it('loads with only a key-features setting', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'sonaKeyFeatures', value: 'Glowing markings' });

		const data = (await load({ platform } as never)) as { sona: { keyFeatures: string } };
		expect(data.sona.keyFeatures).toBe('Glowing markings');
	});

	it('loads with only do lines', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'sonaDos', value: 'Big wings' });

		const data = (await load({ platform } as never)) as { sona: { dos: string[] } };
		expect(data.sona.dos).toEqual(['Big wings']);
	});

	it('loads with only don\'t lines', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'sonaDonts', value: 'No mecha' });

		const data = (await load({ platform } as never)) as { sona: { donts: string[] } };
		expect(data.sona.donts).toEqual(['No mecha']);
	});

	it('404s when the only rows are whitespace-only dos and malformed colors', async () => {
		const { db, platform } = makeDb();
		// Junk that parseLines/parseSonaColors must normalize away — if either
		// parser regresses to passing raw values through, this stops 404ing.
		await db.insert(siteSettings).values([
			{ key: 'sonaDos', value: '\n \n' },
			{ key: 'sonaColors', value: 'not json' }
		]);

		await expect(load({ platform } as never)).rejects.toMatchObject({ status: 404 });
	});

	it('loads when fully populated', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values({ id: 1, title: 'Ref', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 1, tagId: 1 });
		await db.insert(siteSettings).values([
			{ key: 'sonaSpecies', value: 'Dragon' },
			{ key: 'sonaDos', value: 'Big wings' }
		]);

		const data = (await load({ platform } as never)) as {
			refSheet: { slug: string } | null;
			recentArt: unknown[];
			sona: { species: string; dos: string[] };
		};
		expect(data.refSheet?.slug).toBe('art-1');
		expect(data.recentArt).toHaveLength(1);
		expect(data.sona.species).toBe('Dragon');
		expect(data.sona.dos).toEqual(['Big wings']);
	});
});

describe('art load — featured selection (#58)', () => {
	type FeaturedRow = { slug: string; artistName: string | null };

	async function loadFeatured(platform: App.Platform) {
		return (await load({ platform } as never)) as { featuredArt: FeaturedRow[] };
	}

	it('is empty and keeps the recent-art page when nothing is featured', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({ id: 1, title: 'Art', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' });

		const data = await loadFeatured(platform);
		expect(data.featuredArt).toHaveLength(0);
	});

	it('orders by featuredOrder ASC NULLS LAST, then createdAt DESC — first is the hero', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		// order 2, order 1, no order (newer), no order (older)
		await db.insert(images).values([
			{ id: 1, title: 'B', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, featured: true, featuredOrder: 2, createdAt: '2026-01-01T00:00:00.000Z' },
			{ id: 2, title: 'A', slug: 'art-2', imageUrl: 'https://cdn.example.com/2.png', artistId: 1, published: true, featured: true, featuredOrder: 1, createdAt: '2026-01-01T00:00:00.000Z' },
			{ id: 3, title: 'C-new', slug: 'art-3', imageUrl: 'https://cdn.example.com/3.png', artistId: 1, published: true, featured: true, featuredOrder: null, createdAt: '2026-06-01T00:00:00.000Z' },
			{ id: 4, title: 'D-old', slug: 'art-4', imageUrl: 'https://cdn.example.com/4.png', artistId: 1, published: true, featured: true, featuredOrder: null, createdAt: '2026-05-01T00:00:00.000Z' }
		]);

		const data = await loadFeatured(platform);
		expect(data.featuredArt.map((r) => r.slug)).toEqual(['art-2', 'art-1', 'art-3', 'art-4']);
	});

	it('caps the pool at 5 (one hero + four supporting)', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values(
			Array.from({ length: 7 }, (_, i) => ({
				id: i + 1,
				title: `F${i}`,
				slug: `art-${i + 1}`,
				imageUrl: `https://cdn.example.com/${i + 1}.png`,
				artistId: 1,
				published: true,
				featured: true,
				featuredOrder: i + 1,
				createdAt: '2026-01-01T00:00:00.000Z'
			}))
		);

		const data = await loadFeatured(platform);
		expect(data.featuredArt).toHaveLength(5);
	});

	it('excludes unpublished, NSFW, and non-featured images', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values([
			{ id: 1, title: 'Shown', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, featured: true, createdAt: '2026-01-01T00:00:00.000Z' },
			{ id: 2, title: 'Unpublished', slug: 'art-2', imageUrl: 'https://cdn.example.com/2.png', artistId: 1, published: false, featured: true, createdAt: '2026-01-01T00:00:00.000Z' },
			{ id: 3, title: 'NSFW', slug: 'art-3', imageUrl: 'https://cdn.example.com/3.png', artistId: 1, published: true, nsfw: true, featured: true, createdAt: '2026-01-01T00:00:00.000Z' },
			{ id: 4, title: 'Not featured', slug: 'art-4', imageUrl: 'https://cdn.example.com/4.png', artistId: 1, published: true, featured: false, createdAt: '2026-01-01T00:00:00.000Z' }
		]);

		const data = await loadFeatured(platform);
		expect(data.featuredArt.map((r) => r.slug)).toEqual(['art-1']);
	});

	it('joins the artist name for the caption (null when no artist row)', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Kutto' });
		await db.insert(images).values({ id: 1, title: 'Art', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, featured: true, createdAt: '2026-01-01T00:00:00.000Z' });

		const data = await loadFeatured(platform);
		expect(data.featuredArt[0].artistName).toBe('Kutto');
	});
});
