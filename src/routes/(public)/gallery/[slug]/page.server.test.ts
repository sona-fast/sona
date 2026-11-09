import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { artists, collections, images } from '$lib/server/db/schema';
import { load } from './+page.server';
import { makeD1 } from '$lib/server/test/d1';

// SONA-179: lets one case make the neighbor read hang, as a stalled D1 would.
const stall = vi.hoisted(() => ({ neighbors: false }));
vi.mock('$lib/server/gallery-order', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/gallery-order')>();
	return {
		...actual,
		galleryNeighbors: (...args: Parameters<typeof actual.galleryNeighbors>) =>
			stall.neighbors ? new Promise<never>(() => {}) : actual.galleryNeighbors(...args)
	};
});

// SONA-167 receipts: the /ai trust page claims drafts are excluded by the
// database query itself on every public route and return a plain 404. This
// detail route had no server-load test at all — deleting its
// `eq(images.published, true)` constraint would have passed the whole suite
// green. These cases pin the claim for the single-image page.

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
			global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
			aliases TEXT, avatar_resolved_at TEXT, ledger_private INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
		);
		CREATE TABLE collections (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL,
			cover_image_url TEXT, created_at TEXT NOT NULL
		);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL,
			image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER,
			file_size INTEGER, md5hash TEXT, nsfw INTEGER NOT NULL DEFAULT 0,
			published INTEGER NOT NULL DEFAULT 1, source_post_url TEXT, artist_id INTEGER NOT NULL,
			collection_id INTEGER, commissioned_at TEXT, parent_image_id INTEGER,
			variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER,
			created_at TEXT NOT NULL
		);
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT);
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
		CREATE TABLE characters (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
			is_owner INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE image_characters (image_id INTEGER NOT NULL, character_id INTEGER NOT NULL);
	`);
	const d1 = makeD1(sqlite);
	return {
		db: drizzle(d1, { schema }),
		platform: { env: { DB: d1 } } as unknown as App.Platform
	};
}

const NOW = '2026-01-01T00:00:00.000Z';

async function seed(
	db: ReturnType<typeof makeDb>['db'],
	rows: { slug: string; published: boolean; parentImageId?: number }[]
) {
	const [{ id: artistId }] = await db
		.insert(artists)
		.values({ name: 'Arty', createdAt: NOW })
		.returning({ id: artists.id });
	for (const r of rows) {
		await db.insert(images).values({
			title: r.slug,
			slug: r.slug,
			imageUrl: `https://example.com/${r.slug}.png`,
			published: r.published,
			parentImageId: r.parentImageId ?? null,
			artistId,
			createdAt: NOW
		});
	}
}

function loadEvent(platform: App.Platform, slug: string) {
	return { platform, params: { slug }, url: new URL(`https://e2e.test/gallery/${slug}`) } as never;
}

describe('/gallery/[slug] load', () => {
	it('serves a published image', async () => {
		const { db, platform } = makeDb();
		await seed(db, [{ slug: 'pub', published: true }]);
		const data = (await load(loadEvent(platform, 'pub'))) as { image: { slug: string } };
		expect(data.image.slug).toBe('pub');
	});

	it('404s an unpublished image — indistinguishable from a nonexistent one', async () => {
		const { db, platform } = makeDb();
		await seed(db, [{ slug: 'draft', published: false }]);
		await expect(load(loadEvent(platform, 'draft'))).rejects.toMatchObject({ status: 404 });
		await expect(load(loadEvent(platform, 'no-such'))).rejects.toMatchObject({ status: 404 });
	});

	it('excludes unpublished variants from the variant strip', async () => {
		const { db, platform } = makeDb();
		await seed(db, [{ slug: 'parent', published: true }]);
		const parent = (await load(loadEvent(platform, 'parent'))) as { image: { id: number } };
		const artist = await db.select({ id: artists.id }).from(artists).get();
		const artistId = artist!.id;
		await db.insert(images).values([
			{
				title: 'v1', slug: 'v1', imageUrl: 'https://example.com/v1.png',
				published: true, parentImageId: parent.image.id, artistId, createdAt: NOW
			},
			{
				title: 'v2-draft', slug: 'v2-draft', imageUrl: 'https://example.com/v2.png',
				published: false, parentImageId: parent.image.id, artistId, createdAt: NOW
			}
		]);
		const data = (await load(loadEvent(platform, 'parent'))) as { variants: { slug: string }[] };
		const slugs = data.variants.map((v) => v.slug);
		expect(slugs).toContain('v1');
		expect(slugs).not.toContain('v2-draft');
	});

	afterEach(() => {
		stall.neighbors = false;
		vi.useRealTimers();
	});

	it('serves the page without a pager when the neighbor read never answers', async () => {
		const { db, platform } = makeDb();
		await seed(db, [{ slug: 'pub', published: true }]);
		stall.neighbors = true;
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const pending = load(loadEvent(platform, 'pub')) as Promise<{
			image: { slug: string };
			neighbors: { prev: unknown; next: unknown };
		}>;
		await vi.advanceTimersByTimeAsync(10_000);
		const data = await pending;
		expect(data.image.slug).toBe('pub');
		expect(data.neighbors).toEqual({ prev: null, next: null });
	});

	// A version (a variant) follows its original's collection on the piece
	// page, whatever collection its own row names.
	describe('the collection a version shows', () => {
		type Shown = { image: { collectionName: string | null; collectionSlug: string | null } };

		async function seedGroup(opts: {
			parentCollection: 'a' | null;
			variantCollection: 'b' | null;
			parentPublished?: boolean;
		}) {
			const { db, platform } = makeDb();
			const [a, b] = await db
				.insert(collections)
				.values([
					{ name: 'Collection A', slug: 'collection-a', createdAt: NOW },
					{ name: 'Collection B', slug: 'collection-b', createdAt: NOW }
				])
				.returning({ id: collections.id });
			const [{ id: artistId }] = await db
				.insert(artists)
				.values({ name: 'Arty', createdAt: NOW })
				.returning({ id: artists.id });
			const [{ id: parentId }] = await db
				.insert(images)
				.values({
					title: 'parent',
					slug: 'parent',
					imageUrl: 'https://example.com/p.png',
					published: opts.parentPublished ?? true,
					artistId,
					createdAt: NOW,
					collectionId: opts.parentCollection === 'a' ? a.id : null
				})
				.returning({ id: images.id });
			await db.insert(images).values({
				title: 'variant',
				slug: 'variant',
				imageUrl: 'https://example.com/v.png',
				published: true,
				parentImageId: parentId,
				artistId,
				createdAt: NOW,
				collectionId: opts.variantCollection === 'b' ? b.id : null
			});
			return platform;
		}

		const shown = async (platform: App.Platform, slug: string) => {
			const { image } = (await load(loadEvent(platform, slug))) as Shown;
			return { name: image.collectionName, slug: image.collectionSlug };
		};

		it("shows the parent's collection on a version filed in another one", async () => {
			const platform = await seedGroup({ parentCollection: 'a', variantCollection: 'b' });
			expect(await shown(platform, 'variant')).toEqual({ name: 'Collection A', slug: 'collection-a' });
		});

		it('shows no collection on a version whose parent has none, even when the version has one', async () => {
			const platform = await seedGroup({ parentCollection: null, variantCollection: 'b' });
			expect(await shown(platform, 'variant')).toEqual({ name: null, slug: null });
		});

		it("shows the parent's collection on a version with none of its own", async () => {
			const platform = await seedGroup({ parentCollection: 'a', variantCollection: null });
			expect(await shown(platform, 'variant')).toEqual({ name: 'Collection A', slug: 'collection-a' });
		});

		it('leaves the parent page showing its own collection', async () => {
			const platform = await seedGroup({ parentCollection: 'a', variantCollection: 'b' });
			expect(await shown(platform, 'parent')).toEqual({ name: 'Collection A', slug: 'collection-a' });
		});

		it('keeps the own collection of a version whose parent is unpublished, as paging does', async () => {
			const platform = await seedGroup({ parentCollection: 'a', variantCollection: 'b', parentPublished: false });
			expect(await shown(platform, 'variant')).toEqual({ name: 'Collection B', slug: 'collection-b' });
		});

		it('keeps collection fields out of the variant strip', async () => {
			const platform = await seedGroup({ parentCollection: 'a', variantCollection: 'b' });
			const { variants } = (await load(loadEvent(platform, 'variant'))) as { variants: object[] };
			expect(variants).toHaveLength(2);
			for (const v of variants) {
				expect(Object.keys(v).filter((k) => k.startsWith('collection'))).toEqual([]);
			}
		});
	});
});
