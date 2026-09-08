import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { imageTags, images, tags } from '$lib/server/db/schema';
import { makeD1 } from '$lib/server/test/d1';
import { MAX_IMAGE_TAGS, replaceImageTags } from './image-tags';

// The one write path both tag saves share (SONA-220). The edit form and the
// Suggest tags page each post a comma-separated string with no limit of its
// own, so the ceiling on how many tags one image keeps lives here.

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
		CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT,
			image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER,
			md5hash TEXT, nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
			source_post_url TEXT, artist_id INTEGER, collection_id INTEGER, commissioned_at TEXT,
			parent_image_id INTEGER, variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0,
			featured_order INTEGER, created_at TEXT NOT NULL DEFAULT '');
	`);
	return drizzle(makeD1(sqlite), { schema });
}

type Db = ReturnType<typeof makeDb>;

async function tagNamesOf(db: Db, imageId: number) {
	const rows = await db
		.select({ name: tags.name })
		.from(imageTags)
		.innerJoin(tags, eq(imageTags.tagId, tags.id))
		.where(eq(imageTags.imageId, imageId));
	return rows.map((r) => r.name);
}

describe('replaceImageTags', () => {
	it('keeps at most the cap, counted after sanitizing and de-duplicating', async () => {
		const db = makeDb();
		await db.insert(images).values({ id: 1, title: 'Art', slug: 'art', imageUrl: 'https://cdn.example.com/1.png', artistId: 1 });

		// Repeats and junk do not count against the cap; the first hundred real
		// names in input order are what land.
		const names = Array.from({ length: MAX_IMAGE_TAGS + 5 }, (_, i) => `tag-${i}`);
		const input = ['tag-0', 'TAG-0', '!!!', ...names].join(', ');

		const written = await replaceImageTags(db, 1, input);
		expect(written).toHaveLength(MAX_IMAGE_TAGS);
		expect(written[0]).toBe('tag-0');
		expect(written[MAX_IMAGE_TAGS - 1]).toBe(`tag-${MAX_IMAGE_TAGS - 1}`);
		expect(await tagNamesOf(db, 1)).toEqual(written);
		// Nothing past the cap was minted into the tag table either.
		expect(await db.select({ id: tags.id }).from(tags)).toHaveLength(MAX_IMAGE_TAGS);
	});
});
