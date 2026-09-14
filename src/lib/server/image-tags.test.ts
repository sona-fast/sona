import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { imageTags, images, tags } from '$lib/server/db/schema';
import { makeD1 } from '$lib/server/test/d1';
import { TAG_MAX_LENGTH } from '$lib/tags';
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

// `tags.name` is UNIQUE here because it is UNIQUE in schema.ts: the helper's
// insert has to survive another request minting the same name first, and
// without the index the race this file tests would pass either way.
const SCHEMA_SQL = `
	CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT '');
	CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
	CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT,
		image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER,
		md5hash TEXT, nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
		source_post_url TEXT, artist_id INTEGER, collection_id INTEGER, commissioned_at TEXT,
		parent_image_id INTEGER, variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0,
		featured_order INTEGER, created_at TEXT NOT NULL DEFAULT '');
`;

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(SCHEMA_SQL);
	return drizzle(makeD1(sqlite), { schema });
}

/**
 * A database where another request mints `name` in the gap between this one's
 * "does the tag exist" select and its insert — two backfill rows saving at once
 * with a tag name in common. The select sees nothing, the insert meets the
 * unique index.
 */
function makeRacingDb(name: string) {
	const sqlite = new Database(':memory:');
	sqlite.exec(SCHEMA_SQL);
	const d1 = makeD1(sqlite);
	let raced = false;
	const steal = () => {
		if (raced) return;
		raced = true;
		sqlite.prepare('INSERT INTO tags (name) VALUES (?)').run(name);
	};
	// drizzle reads a select through raw(); the helper's re-select after the
	// conflict goes through here too, which `raced` makes a no-op.
	const racing = {
		...d1,
		prepare(sql: string) {
			const stmt = d1.prepare(sql);
			if (!/^select/i.test(sql) || !sql.includes('"tags"')) return stmt;
			return {
				bind: (...params: unknown[]) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const bound = (stmt as any).bind(...params);
					return {
						...bound,
						raw: () => {
							const out = bound.raw();
							steal();
							return out;
						},
						all: () => {
							const out = bound.all();
							steal();
							return out;
						}
					};
				}
			};
		}
	};
	return {
		db: drizzle(racing as unknown as ReturnType<typeof makeD1>, { schema }),
		sqlite
	};
}

/**
 * The same race, one step further: the other request mints `name` after this
 * one's first look — so the insert meets the unique index — and deletes it
 * again before the re-select that follows the conflict. Neither the insert nor
 * the re-select yields a tag row, which is the one path that skips a name.
 */
function makeVanishingDb(name: string) {
	const sqlite = new Database(':memory:');
	sqlite.exec(SCHEMA_SQL);
	const d1 = makeD1(sqlite);
	let looks = 0;
	const around = <T>(run: () => T): T => {
		looks += 1;
		// Second look: the re-select after the conflict. The row the other request
		// minted is gone by the time this one reads.
		if (looks === 2) sqlite.prepare('DELETE FROM tags WHERE name = ?').run(name);
		const out = run();
		// First look found nothing; the other request mints the name now.
		if (looks === 1) sqlite.prepare('INSERT INTO tags (name) VALUES (?)').run(name);
		return out;
	};
	const racing = {
		...d1,
		prepare(sql: string) {
			const stmt = d1.prepare(sql);
			if (!/^select/i.test(sql) || !sql.includes('"tags"')) return stmt;
			return {
				bind: (...params: unknown[]) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const bound = (stmt as any).bind(...params);
					// Only the looks at THIS name; the other names in the same save go
					// through untouched, so the test can show they still land.
					if (!params.includes(name)) return bound;
					return {
						...bound,
						raw: () => around(() => bound.raw()),
						all: () => around(() => bound.all())
					};
				}
			};
		}
	};
	return {
		db: drizzle(racing as unknown as ReturnType<typeof makeD1>, { schema }),
		sqlite
	};
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

	// Two backfill rows save at once (the page's guard is per row) and two
	// untagged images by one artist share tag names, so both saves can find no
	// `fox` row and both insert it. Before, the loser threw the unique
	// constraint, the action answered with an error, and the page rendered it
	// over the list — discarding every other row's staged chips.
	it('links to the existing tag when another save mints the name first', async () => {
		const { db, sqlite } = makeRacingDb('fox');
		await db.insert(images).values({ id: 1, title: 'Art', slug: 'art', imageUrl: 'https://cdn.example.com/1.png', artistId: 1 });

		await expect(replaceImageTags(db, 1, 'fox')).resolves.toEqual(['fox']);

		// One tag row, and the image points at the one the other save minted.
		const rows = sqlite.prepare("SELECT id FROM tags WHERE name = 'fox'").all();
		expect(rows).toHaveLength(1);
		expect(await tagNamesOf(db, 1)).toEqual(['fox']);
		const linked = await db.select({ tagId: imageTags.tagId }).from(imageTags).where(eq(imageTags.imageId, 1));
		expect(linked).toEqual([{ tagId: rows[0].id }]);
	});

	// The other save minted the name and then deleted it again, so the re-select
	// after the unique conflict finds nothing either. One name is unwritable;
	// failing the whole save over it would throw away the names that are fine.
	it('skips a name whose tag row is deleted between the conflict and the re-select', async () => {
		const { db, sqlite } = makeVanishingDb('fox');
		await db.insert(images).values({ id: 1, title: 'Art', slug: 'art', imageUrl: 'https://cdn.example.com/1.png', artistId: 1 });

		await expect(replaceImageTags(db, 1, 'fox, bird')).resolves.toEqual(['bird']);

		// No image_tags row points at the name that went, and the one that did not
		// go is written in the same call.
		expect(await tagNamesOf(db, 1)).toEqual(['bird']);
		expect(sqlite.prepare("SELECT id FROM tags WHERE name = 'fox'").all()).toHaveLength(0);
		const linked = await db.select({ tagId: imageTags.tagId }).from(imageTags).where(eq(imageTags.imageId, 1));
		expect(linked).toHaveLength(1);
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

	it('accepts a legal count of the longest names there is, and blames the count past it', () => {
		// The two caps have to agree: 100 names of TAG_MAX_LENGTH separated by ", "
		// is 5,198 characters, and a flat 4000-character ceiling refused it as too
		// long — the wrong problem, and one the operator cannot fix by removing a
		// tag. The count is what refuses one tag more.
		const longName = (i: number) => `${String(i).padStart(3, '0')}`.padEnd(TAG_MAX_LENGTH, 'a');
		const legal = Array.from({ length: MAX_IMAGE_TAGS }, (_, i) => longName(i)).join(', ');
		expect(legal.length).toBeLessThanOrEqual(MAX_TAGS_INPUT_LENGTH);
		expect(readTagInput(legal)).toEqual({ problem: null, value: legal });

		// One name past the count, at a length the ceiling still admits, so the
		// refusal names the count rather than the characters.
		const overCount = Array.from({ length: MAX_IMAGE_TAGS + 1 }, (_, i) => `tag-${i}`).join(', ');
		expect(overCount.length).toBeLessThanOrEqual(MAX_TAGS_INPUT_LENGTH);
		expect(readTagInput(overCount)).toEqual({ problem: 'too_many' });
	});

	it('accepts an ordinary field and hands back the value to write', () => {
		expect(readTagInput('  fox, Fox , , bird ')).toEqual({
			problem: null,
			value: 'fox, Fox , , bird'
		});
	});
});
