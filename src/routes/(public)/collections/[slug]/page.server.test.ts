import { describe, it, expect } from 'vitest';
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { artists, collections, images } from '$lib/server/db/schema';
import { load } from './+page.server';
import { makeD1 } from '$lib/server/test/d1';

// SONA-167 receipts: like /gallery/[slug], this route had no server-load test,
// so its `eq(images.published, true)` filter was unpinned — deleting it would
// have published every draft in a collection with the suite still green.

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
	`);
	const d1 = makeD1(sqlite);
	return {
		db: drizzle(d1, { schema }),
		platform: { env: { DB: d1 } } as unknown as App.Platform
	};
}

const NOW = '2026-01-01T00:00:00.000Z';

function loadEvent(platform: App.Platform, slug: string) {
	return { platform, params: { slug } } as never;
}

describe('/collections/[slug] load', () => {
	it('404s an unknown collection', async () => {
		const { platform } = makeDb();
		await expect(load(loadEvent(platform, 'nope'))).rejects.toMatchObject({ status: 404 });
	});

	it('lists only published top-level images of the collection', async () => {
		const { db, platform } = makeDb();
		const [{ id: artistId }] = await db
			.insert(artists)
			.values({ name: 'Arty', createdAt: NOW })
			.returning({ id: artists.id });
		const [{ id: collectionId }] = await db
			.insert(collections)
			.values({ name: 'Con badges', slug: 'con-badges', createdAt: NOW })
			.returning({ id: collections.id });
		const base = { imageUrl: 'https://example.com/i.png', artistId, collectionId, createdAt: NOW };
		const [{ id: parentId }] = await db
			.insert(images)
			.values({ ...base, title: 'pub', slug: 'pub', published: true })
			.returning({ id: images.id });
		await db.insert(images).values([
			{ ...base, title: 'draft', slug: 'draft', published: false },
			// A published VARIANT stays out of the collection grid (top-level only).
			{ ...base, title: 'variant', slug: 'variant', published: true, parentImageId: parentId }
		]);
		const data = (await load(loadEvent(platform, 'con-badges'))) as {
			images: { slug: string }[];
		};
		expect(data.images.map((i) => i.slug)).toEqual(['pub']);
	});
});
