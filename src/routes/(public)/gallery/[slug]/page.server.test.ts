import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { artists, images } from '$lib/server/db/schema';
import { load } from './+page.server';
import { load as collectionLoad } from '../../collections/[slug]/+page.server';
import { makeD1 } from '$lib/server/test/d1';

// SONA-179: lets one case make the neighbor read hang, as a stalled D1 would,
// and another make the collection position read fail outright.
const stall = vi.hoisted(() => ({ neighbors: false, positionFails: false }));
vi.mock('$lib/server/gallery-order', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/gallery-order')>();
	return {
		...actual,
		galleryNeighbors: (...args: Parameters<typeof actual.galleryNeighbors>) =>
			stall.neighbors ? new Promise<never>(() => {}) : actual.galleryNeighbors(...args),
		collectionNeighbors: (...args: Parameters<typeof actual.collectionNeighbors>) =>
			stall.neighbors ? new Promise<never>(() => {}) : actual.collectionNeighbors(...args),
		collectionPosition: (...args: Parameters<typeof actual.collectionPosition>) =>
			stall.positionFails ? Promise.reject(new Error('D1 error')) : actual.collectionPosition(...args)
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
		sqlite,
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
		stall.positionFails = false;
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
	// The "4 of 7 in <collection>" line and the pager's name in a collection.
	describe('the collection pager', () => {
		type Pager = { name: string; slug: string; position: number; total: number } | null;
		type Data = { collectionPager: Pager; neighbors: { prev: unknown; next: unknown } };

		/**
		 * Collection "Badges" (1) lists five originals, newest first: c5, c4,
		 * then c3 and c2 sharing one upload date (the higher id first), then
		 * c1. Also filed in it, and never counted: a variant of c3 (which
		 * pages from c3's place), a draft newer than all of them, and a
		 * variant of the out-of-collection piece o1. Collection "Other" (2)
		 * holds o1, which is newer than every Badges piece.
		 */
		function seedCollection() {
			const { sqlite, platform } = makeDb();
			sqlite.exec(`
				INSERT INTO artists (id, name, created_at) VALUES (1, 'Arty', '${NOW}');
				INSERT INTO collections (id, name, slug, created_at) VALUES
					(1, 'Badges', 'badges', '${NOW}'), (2, 'Other', 'other', '${NOW}');
				INSERT INTO images (id, title, slug, image_url, artist_id, collection_id, published, parent_image_id, created_at) VALUES
					(1, 'c1', 'c1', '/c1.png', 1, 1, 1, NULL, '2026-01-01T00:00:00.000Z'),
					(2, 'c2', 'c2', '/c2.png', 1, 1, 1, NULL, '2026-01-02T00:00:00.000Z'),
					(3, 'c3', 'c3', '/c3.png', 1, 1, 1, NULL, '2026-01-02T00:00:00.000Z'),
					(4, 'c4', 'c4', '/c4.png', 1, 1, 1, NULL, '2026-01-04T00:00:00.000Z'),
					(5, 'c5', 'c5', '/c5.png', 1, 1, 1, NULL, '2026-01-05T00:00:00.000Z'),
					(6, 'o1', 'o1', '/o1.png', 1, 2, 1, NULL, '2026-02-01T00:00:00.000Z'),
					(7, 'c3 alt', 'c3-alt', '/c3-alt.png', 1, 1, 1, 3, '2026-03-01T00:00:00.000Z'),
					(8, 'draft', 'draft', '/draft.png', 1, 1, 0, NULL, '2026-03-01T00:00:00.000Z'),
					(9, 'o1 alt', 'o1-alt', '/o1-alt.png', 1, 1, 1, 6, '2026-03-01T00:00:00.000Z');
			`);
			return platform;
		}

		const at = (platform: App.Platform, slug: string, query = '?collection=badges') =>
			load({
				platform,
				params: { slug },
				url: new URL(`https://e2e.test/gallery/${slug}${query}`)
			} as never) as Promise<Data>;

		it("numbers every card by its place in the collection page's grid, out of the grid's size", async () => {
			const platform = seedCollection();
			const grid = (
				(await collectionLoad({ platform, params: { slug: 'badges' } } as never)) as { images: { slug: string }[] }
			).images.map((i) => i.slug);
			// The tie between c3 and c2 is settled by id, newest id first.
			expect(grid).toEqual(['c5', 'c4', 'c3', 'c2', 'c1']);
			for (const [i, slug] of grid.entries()) {
				const { collectionPager } = await at(platform, slug);
				expect(collectionPager, slug).toEqual({ name: 'Badges', slug: 'badges', position: i + 1, total: 5 });
			}
		});

		it("gives a variant its parent's place, not one of its own", async () => {
			const platform = seedCollection();
			expect((await at(platform, 'c3-alt')).collectionPager).toEqual({
				name: 'Badges',
				slug: 'badges',
				position: 3,
				total: 5
			});
		});

		it('has no collection pager in a gallery context, or with no context at all', async () => {
			const platform = seedCollection();
			expect((await at(platform, 'c3', '')).collectionPager).toBeNull();
			expect((await at(platform, 'c3', '?sort=oldest')).collectionPager).toBeNull();
		});

		it.each([
			['a collection that does not exist', 'c3', '?collection=no-such'],
			["another collection's slug", 'c3', '?collection=other'],
			['a variant filed in the collection whose parent is not', 'o1-alt', '?collection=badges']
		])('has no collection pager for %s', async (_label, slug, query) => {
			const platform = seedCollection();
			const data = await at(platform, slug, query);
			expect(data.collectionPager).toBeNull();
			// The pager itself still shows, in the gallery's order.
			expect(data.neighbors.prev ?? data.neighbors.next).not.toBeNull();
		});

		it('drops the position line with the pager when the collection walk never answers', async () => {
			const platform = seedCollection();
			stall.neighbors = true;
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const pending = at(platform, 'c3');
			await vi.advanceTimersByTimeAsync(10_000);
			const data = await pending;
			expect(data.neighbors).toEqual({ prev: null, next: null });
			expect(data.collectionPager).toBeNull();
		});

		it('drops the pager with the position line when the position read fails', async () => {
			const platform = seedCollection();
			stall.positionFails = true;
			const data = await at(platform, 'c3');
			expect(data.collectionPager).toBeNull();
			expect(data.neighbors).toEqual({ prev: null, next: null });
		});
	});
});
