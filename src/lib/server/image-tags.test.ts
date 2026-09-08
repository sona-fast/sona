import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { imageTags, images, tags } from '$lib/server/db/schema';
import { makeD1 } from '$lib/server/test/d1';
import {
	MAX_IMAGE_TAGS,
	MAX_TAGS_INPUT_LENGTH,
	parseImageTags,
	readTagInput,
	replaceImageTags
} from './image-tags';

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

describe('parseImageTags', () => {
	// What the save actions count before they refuse an over-cap list, so it has
	// to count what the write would keep: sanitized, blanks out, repeats collapsed.
	it('sanitizes, drops blanks and collapses repeats, in input order', () => {
		expect(parseImageTags('Digital Media, fox, FOX, !!!, , fox')).toEqual(['digital-media', 'fox']);
		expect(parseImageTags('')).toEqual([]);
	});
});

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

	// Clearing the Tags box is how an image loses its tags, so an empty string is
	// a real instruction to delete rather than a no-op. The upload action skips
	// this call entirely for a just-inserted image, which is only safe while an
	// empty field keeps meaning "delete" here.
	it('clears an image that had tags when the field comes in empty', async () => {
		const db = makeDb();
		await db.insert(images).values({ id: 1, title: 'Art', slug: 'art', imageUrl: 'https://cdn.example.com/1.png', artistId: 1 });
		await replaceImageTags(db, 1, 'fox, bird');
		expect(await tagNamesOf(db, 1)).toEqual(['fox', 'bird']);

		expect(await replaceImageTags(db, 1, '')).toEqual([]);
		expect(await tagNamesOf(db, 1)).toEqual([]);
		// The tag rows themselves survive: other images may still carry them.
		expect(await db.select({ id: tags.id }).from(tags)).toHaveLength(2);
	});
});

describe('readTagInput', () => {
	it('measures the length before sanitizing, so a long field cannot pass by being cut', () => {
		// sanitizeText shortens to the same ceiling, so checking the sanitized value
		// would accept every over-long field instead of refusing it.
		const huge = 'a'.repeat(MAX_TAGS_INPUT_LENGTH + 1);
		// No value beside the problem: a refused field has nothing to write, and a
		// caller that forwarded the empty string it once carried would clear the
		// image's tags instead of refusing the save.
		expect(readTagInput(huge)).toEqual({ problem: 'too_long' });
	});

	it('counts the sanitized value, which is what the write would store', () => {
		const tooMany = Array.from({ length: MAX_IMAGE_TAGS + 1 }, (_, i) => `tag-${i}`).join(', ');
		expect(readTagInput(tooMany)).toEqual({ problem: 'too_many' });
	});

	it('accepts an ordinary field and hands back the value to write', () => {
		expect(readTagInput('  fox, Fox , , bird ')).toEqual({
			problem: null,
			value: 'fox, Fox , , bird'
		});
	});
});
