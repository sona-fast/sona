import { describe, it, expect } from 'vitest';
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { artists, images } from '$lib/server/db/schema';
import { load } from './+page.server';
import { makeD1 } from '$lib/server/test/d1';

// SONA-167 receipts: the /ai trust page claims drafts are excluded by the
// database query itself on every public route and return a plain 404. This
// detail route had no server-load test at all — deleting its
// `eq(images.published, true)` constraint would have passed the whole suite
// green. These cases pin the claim for the single-image page.

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
			global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
			aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL
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
	return { platform, params: { slug } } as never;
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
});
