import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { imageTags, images, tags } from '$lib/server/db/schema';
import { makeD1 } from '$lib/server/test/d1';
import { MAX_IMAGE_TAGS, MAX_TAGS_INPUT_LENGTH } from '$lib/server/image-tags';
import { load, actions, _MAX_SCAN as MAX_SCAN, _PER_PAGE as PER_PAGE } from './+page.server';

// The backfill list (SONA-220). What is worth pinning here is which rows reach
// the page — an image is a candidate only when its source URL is one the
// suggestion endpoint would accept AND it has no tags — and that accepting a
// row writes tags through the same path the edit form's save uses.

const BSKY = 'https://bsky.app/profile/kirin.example/post/3kq7x2abc';
const X = 'https://x.com/kirin_draws/status/1834455667788990011';

type Query = { sql: string; params: unknown[] };

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT,
			patreon_url TEXT, instagram_url TEXT, global_id TEXT, registry_version INTEGER,
			registry_synced_at TEXT, aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
		CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT,
			image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER,
			md5hash TEXT, nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
			source_post_url TEXT, artist_id INTEGER, collection_id INTEGER, commissioned_at TEXT,
			parent_image_id INTEGER, variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0,
			featured_order INTEGER, created_at TEXT NOT NULL DEFAULT '');
	`);
	const d1 = makeD1(sqlite);
	// Every statement the load runs, so a test can assert WHICH columns are read
	// for how many rows, not only what comes back.
	const queries: Query[] = [];
	const prepare = d1.prepare.bind(d1);
	const logged = {
		...d1,
		prepare: (sql: string) => {
			const stmt = prepare(sql);
			return {
				...stmt,
				bind: (...params: unknown[]) => {
					queries.push({ sql, params });
					return stmt.bind(...params);
				}
			};
		}
	} as unknown as typeof d1;
	return {
		db: drizzle(logged, { schema }),
		platform: { env: { DB: logged } } as unknown as App.Platform,
		queries
	};
}

type Db = ReturnType<typeof makeDb>['db'];

async function seedImage(db: Db, id: number, sourcePostUrl: string | null, title = `Art ${id}`) {
	await db.insert(images).values({
		id,
		title,
		slug: `art-${id}`,
		imageUrl: `https://cdn.example.com/${id}.png`,
		artistId: 1,
		sourcePostUrl
	});
}

async function tagImage(db: Db, imageId: number, name: string) {
	const [tag] = await db.insert(tags).values({ name }).returning({ id: tags.id });
	await db.insert(imageTags).values({ imageId, tagId: tag.id });
}

const runLoad = (platform: App.Platform, search = '') =>
	load({ platform, url: new URL(`http://localhost/admin/images/suggest-tags${search}`) } as never) as Promise<{
		rows: { id: number; source: string; title: string }[];
		total: number;
		pages: number;
	}>;

function form(fields: Record<string, string>): Request {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return new Request('http://localhost/admin/images/suggest-tags', { method: 'POST', body: fd });
}

async function tagNamesOf(db: Db, imageId: number) {
	const rows = await db
		.select({ name: tags.name })
		.from(imageTags)
		.innerJoin(tags, eq(imageTags.tagId, tags.id))
		.where(eq(imageTags.imageId, imageId));
	return rows.map((r) => r.name).sort();
}

describe('suggest-tags load', () => {
	it('lists only untagged images whose source URL the endpoint would accept', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 1, BSKY);
		await seedImage(db, 2, X);
		// A source post we have no classifier for.
		await seedImage(db, 3, 'https://www.furaffinity.net/view/12345/');
		await seedImage(db, 4, null);
		await seedImage(db, 5, '');
		// A Bluesky post that already has a tag: nothing to backfill.
		await seedImage(db, 6, BSKY);
		await tagImage(db, 6, 'fox');

		const data = await runLoad(platform);
		expect(data.rows.map((r) => r.id)).toEqual([2, 1]);
		expect(data.total).toBe(2);
	});

	it("names each row's source kind, which is what the row meta line shows", async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 1, BSKY);
		await seedImage(db, 2, X);

		const data = await runLoad(platform);
		expect(data.rows.find((r) => r.id === 1)?.source).toBe('bluesky');
		expect(data.rows.find((r) => r.id === 2)?.source).toBe('x');
	});

	it('shows one page at a time and reports the full total behind Load more', async () => {
		const { db, platform } = makeDb();
		for (let i = 1; i <= PER_PAGE + 3; i++) await seedImage(db, i, BSKY);

		const first = await runLoad(platform);
		expect(first.rows).toHaveLength(PER_PAGE);
		expect(first.total).toBe(PER_PAGE + 3);

		// Load more grows the page rather than paging away from it, so the rows
		// already worked through stay where they were.
		const second = await runLoad(platform, '?pages=2');
		expect(second.rows).toHaveLength(PER_PAGE + 3);
		expect(second.rows.slice(0, PER_PAGE).map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
	});

	it('scans ids only, and fetches display columns for the rendered rows alone', async () => {
		// The scan can reach MAX_SCAN rows to render twenty. Carrying titles,
		// thumbnails and image URLs through it puts hundreds of kilobytes in one
		// D1 response, against a 1 MB cap.
		const { db, platform, queries } = makeDb();
		for (let i = 1; i <= PER_PAGE + 3; i++) await seedImage(db, i, BSKY);
		queries.length = 0;

		const data = await runLoad(platform);
		expect(data.rows).toHaveLength(PER_PAGE);
		expect(data.total).toBe(PER_PAGE + 3);

		const scan = queries.find((q) => q.sql.includes('"source_post_url"'));
		expect(scan, 'the candidate scan did not run').toBeTruthy();
		expect(scan!.sql).not.toContain('"title"');
		expect(scan!.sql).not.toContain('"thumbnail_url"');

		// One display query, bound to exactly the ids on the page.
		const display = queries.filter((q) => q.sql.includes('"title"'));
		expect(display).toHaveLength(1);
		expect(display[0].params).toEqual(data.rows.map((r) => r.id));
	});

	it('chunks the display fetch, since Load more can grow past D1 bound parameters', async () => {
		const { db, platform, queries } = makeDb();
		for (let i = 1; i <= 130; i++) await seedImage(db, i, BSKY);
		queries.length = 0;

		const data = await runLoad(platform, '?pages=7');
		expect(data.rows).toHaveLength(130);

		const display = queries.filter((q) => q.sql.includes('"title"'));
		expect(display.length).toBeGreaterThan(1);
		for (const q of display) expect(q.params.length).toBeLessThanOrEqual(100);
		// Between them the chunks cover the page, in order.
		expect(display.flatMap((q) => q.params)).toEqual(data.rows.map((r) => r.id));
	});

	it('stops at the scan ceiling and reports a total capped at it', async () => {
		// A library where nothing is tagged yet would otherwise classify the whole
		// images table on every page view. Past the ceiling the page shows what it
		// found and says so with a capped total rather than the true count.
		const { db, platform } = makeDb();
		await db.insert(images).values(
			Array.from({ length: MAX_SCAN + 5 }, (_, i) => ({
				id: i + 1,
				title: `Art ${i + 1}`,
				slug: `art-${i + 1}`,
				imageUrl: `https://cdn.example.com/${i + 1}.png`,
				artistId: 1,
				sourcePostUrl: BSKY
			}))
		);

		const data = await runLoad(platform);
		expect(data.total).toBe(MAX_SCAN);
		expect(data.rows).toHaveLength(PER_PAGE);
		// Newest first, so the ceiling drops the oldest rows, not the newest.
		expect(data.rows[0].id).toBe(MAX_SCAN + 5);
	});

	it('reads a junk or missing pages parameter as the first page', async () => {
		const { db, platform } = makeDb();
		for (let i = 1; i <= PER_PAGE + 1; i++) await seedImage(db, i, BSKY);

		for (const search of ['', '?pages=0', '?pages=-3', '?pages=banana']) {
			expect((await runLoad(platform, search)).rows).toHaveLength(PER_PAGE);
		}
	});
});

describe('suggest-tags save action', () => {
	it('writes the accepted tags and reports which ones landed', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 1, BSKY);

		const result = await actions.save({ request: form({ id: '1', tags: 'fox, beach' }), platform } as never);
		expect(result).toMatchObject({ savedId: 1, savedTags: ['fox', 'beach'] });
		expect(await tagNamesOf(db, 1)).toEqual(['beach', 'fox']);
	});

	it('sanitizes through the same rule the tag inputs use', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 1, BSKY);

		await actions.save({ request: form({ id: '1', tags: 'Digital Media, FOX!' }), platform } as never);
		expect(await tagNamesOf(db, 1)).toEqual(['digital-media', 'fox']);
	});

	it('reuses an existing tag row rather than minting a second one', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 1, BSKY);
		await seedImage(db, 2, BSKY);
		await tagImage(db, 2, 'fox');

		await actions.save({ request: form({ id: '1', tags: 'fox' }), platform } as never);
		const rows = await db.select({ id: tags.id }).from(tags).where(eq(tags.name, 'fox'));
		expect(rows).toHaveLength(1);
	});

	it('refuses an id that is not a real image, and one that is not an id at all', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 1, BSKY);

		const missing = await actions.save({ request: form({ id: '99', tags: 'fox' }), platform } as never);
		expect(missing).toMatchObject({ status: 404 });
		const junk = await actions.save({ request: form({ id: 'banana', tags: 'fox' }), platform } as never);
		expect(junk).toMatchObject({ status: 400 });
		// Neither wrote anything.
		expect(await tagNamesOf(db, 1)).toEqual([]);
	});

	it('refuses to overwrite tags the image picked up since the list loaded', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 1, BSKY);
		// The list showed image 1 as untagged; the edit form tagged it meanwhile.
		await tagImage(db, 1, 'fox');

		const result = await actions.save({ request: form({ id: '1', tags: 'beach, sand' }), platform } as never);
		expect(result).toMatchObject({ status: 409, data: { error: 'tagged_elsewhere' } });
		// The tag written elsewhere is still there and nothing from the row landed.
		expect(await tagNamesOf(db, 1)).toEqual(['fox']);
	});

	it('refuses an over-cap list, the way the two forms do', async () => {
		// These tags come from the tray, so reaching the cap takes a hand-made post.
		// The three write paths still agree, and this one refuses rather than
		// storing the first hundred and reporting success.
		const { db, platform } = makeDb();
		await seedImage(db, 1, BSKY);
		const tooMany = Array.from({ length: MAX_IMAGE_TAGS + 1 }, (_, i) => `cap-test-tag-${i}`).join(', ');

		const result = await actions.save({ request: form({ id: '1', tags: tooMany }), platform } as never);
		expect(result).toMatchObject({ status: 400, data: { error: 'too_many_tags' } });
		expect(await tagNamesOf(db, 1)).toEqual([]);

		const huge = await actions.save({
			request: form({ id: '1', tags: 'a'.repeat(MAX_TAGS_INPUT_LENGTH + 1) }),
			platform
		} as never);
		expect(huge).toMatchObject({ status: 400, data: { error: 'too_many_tags' } });
		expect(await tagNamesOf(db, 1)).toEqual([]);
	});

	it('saves nothing when every chip was left out', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 1, BSKY);

		const result = await actions.save({ request: form({ id: '1', tags: '' }), platform } as never);
		expect(result).toMatchObject({ savedId: 1, savedTags: [] });
		expect(await tagNamesOf(db, 1)).toEqual([]);
	});
});
