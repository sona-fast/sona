import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { characters, imageTags, images, siteSettings, tags } from '$lib/server/db/schema';
import { load, actions } from './+page.server';

import { makeD1, withFailingSettingsRead } from '$lib/server/test/d1';
import { MAX_IMAGE_TAGS, MAX_TAGS_INPUT_LENGTH } from '$lib/server/image-tags';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		-- The load resolves the FuzzySearch key from here (SONA-156).
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
			bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT, patreon_url TEXT,
			instagram_url TEXT, global_id TEXT, registry_version INTEGER, registry_synced_at TEXT, aliases TEXT, avatar_resolved_at TEXT,
			created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL, cover_image_url TEXT, created_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
		CREATE TABLE image_characters (image_id INTEGER NOT NULL, character_id INTEGER NOT NULL);
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
			variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER, created_at TEXT NOT NULL DEFAULT ''
		);
	`);
	const d1 = makeD1(sqlite);
	// Every statement the action runs, so a test can assert which writes an
	// upload issues rather than only what ends up stored.
	const queries: string[] = [];
	const prepare = d1.prepare.bind(d1);
	const logged = {
		...d1,
		prepare: (sql: string) => {
			queries.push(sql);
			return prepare(sql);
		}
	} as unknown as typeof d1;
	return {
		db: drizzle(logged, { schema }),
		platform: { env: { DB: logged } } as unknown as App.Platform,
		queries
	};
}

// The upload action ends in redirect(302, …), which throws; swallow it.
async function callDefault(args: { request: Request; platform: App.Platform }) {
	try {
		return await actions.default(args as never);
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e && 'location' in e) return e;
		throw e;
	}
}

function form(fields: Record<string, string>): Request {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return new Request('http://localhost/admin/upload', { method: 'POST', body: fd });
}

function shortTags(n: number): string[] {
	const letters = 'abcdefghijklmnopqrstuvwxyz';
	const names: string[] = [];
	for (const a of letters) {
		names.push(a);
		if (names.length === n) return names;
	}
	for (const a of letters) {
		for (const b of letters) {
			names.push(a + b);
			if (names.length === n) return names;
		}
	}
	return names;
}

describe('admin upload — tag cap', () => {
	it('refuses a tag list past the cap and uploads nothing', async () => {
		const { db, platform } = makeDb();
		const tooMany = shortTags(MAX_IMAGE_TAGS + 1).join(', ');

		const result = await callDefault({
			request: form({ count: '1', imageUrl_0: 'https://cdn.example.com/new.png', title: 'New Art', artistId: '1', tags: tooMany }),
			platform
		});

		expect((result as { status: number }).status).toBe(400);
		expect((result as { data: { error: string } }).data.error).toBe('Use up to 100 tags.');
		expect(await db.select({ id: images.id }).from(images).get()).toBeUndefined();
	});

	// The field used to be cut to 500 characters BEFORE the count guard ran, so a
	// hundred and one ordinary names arrived as sixty-odd with the last one
	// truncated mid-word, and uploaded as a success.
	it('refuses ordinary-length names past the cap instead of truncating them', async () => {
		const { db, platform } = makeDb();
		const tooMany = Array.from({ length: MAX_IMAGE_TAGS + 1 }, (_, i) => `cap-test-tag-${i}`).join(', ');
		expect(tooMany.length).toBeGreaterThan(500);

		const result = await callDefault({
			request: form({ count: '1', imageUrl_0: 'https://cdn.example.com/new.png', title: 'New Art', artistId: '1', tags: tooMany }),
			platform
		});

		expect((result as { status: number }).status).toBe(400);
		expect((result as { data: { error: string } }).data.error).toBe('Use up to 100 tags.');
		expect(await db.select({ id: images.id }).from(images).get()).toBeUndefined();
		expect(await db.select({ id: tags.id }).from(tags).get()).toBeUndefined();
	});

	it('refuses a tags field longer than the input ceiling', async () => {
		const { db, platform } = makeDb();
		const huge = 'a'.repeat(MAX_TAGS_INPUT_LENGTH + 1);

		const result = await callDefault({
			request: form({ count: '1', imageUrl_0: 'https://cdn.example.com/new.png', title: 'New Art', artistId: '1', tags: huge }),
			platform
		});

		expect((result as { status: number }).status).toBe(400);
		expect((result as { data: { error: string } }).data.error).toBe(
			`Tags are too long. Use up to ${MAX_TAGS_INPUT_LENGTH} characters.`
		);
		expect(await db.select({ id: images.id }).from(images).get()).toBeUndefined();
	});
});

describe('admin upload — tags that are accepted', () => {
	it('issues no tag delete when the Tags field is empty', async () => {
		// The shared write opens with a delete, which is what clearing the field on
		// the edit form needs. A just-inserted image has nothing to delete, and a
		// variant set would run one such delete per tile.
		const { platform, queries } = makeDb();

		await callDefault({
			request: form({
				count: '2',
				imageUrl_0: 'https://cdn.example.com/a.png',
				imageUrl_1: 'https://cdn.example.com/b.png',
				title: 'No Tags',
				artistId: '1',
				tags: ''
			}),
			platform
		});

		expect(queries.some((sql) => /delete from "image_tags"/i.test(sql))).toBe(false);
	});

	it('writes the sanitized, de-duplicated names to the new image', async () => {
		// The upload writes through replaceImageTags, the same call the edit form and
		// the Suggest tags page use. Without a successful upload here, dropping that
		// call would leave the cap tests above green and store no tags at all.
		const { db, platform } = makeDb();

		await callDefault({
			request: form({
				count: '1',
				imageUrl_0: 'https://cdn.example.com/new.png',
				title: 'New Art',
				artistId: '1',
				tags: 'fox, Fox , , fox, bird'
			}),
			platform
		});

		const newImage = await db.select({ id: images.id }).from(images).get();
		expect(newImage?.id).toBeTruthy();
		const written = await db
			.select({ name: tags.name })
			.from(imageTags)
			.innerJoin(tags, eq(tags.id, imageTags.tagId))
			.where(eq(imageTags.imageId, newImage!.id));
		// Sorted: the select has no orderBy, so the row order is the database's.
		expect(written.map((row) => row.name).sort()).toEqual(['bird', 'fox']);
	});
});

describe('admin upload — use as reference sheet', () => {
	it('sets the owner reference to the uploaded image when the box is checked', async () => {
		const { db, platform } = makeDb();
		const [c] = await db.insert(characters).values({ name: 'Owner', isOwner: true }).returning({ id: characters.id });

		await callDefault({
			request: form({ count: '1', imageUrl_0: 'https://cdn.example.com/new.png', title: 'New Art', artistId: '1', useAsReference: 'on' }),
			platform
		});

		const newImage = await db.select({ id: images.id }).from(images).get();
		const owner = await db.select({ ref: characters.referenceImageId }).from(characters).where(eq(characters.id, c.id)).get();
		expect(owner?.ref).toBe(newImage?.id);
	});

	it('leaves the reference unset when the box is unchecked', async () => {
		const { db, platform } = makeDb();
		const [c] = await db.insert(characters).values({ name: 'Owner', isOwner: true }).returning({ id: characters.id });

		await callDefault({
			request: form({ count: '1', imageUrl_0: 'https://cdn.example.com/new.png', title: 'New Art', artistId: '1' }),
			platform
		});

		const owner = await db.select({ ref: characters.referenceImageId }).from(characters).where(eq(characters.id, c.id)).get();
		expect(owner?.ref ?? null).toBe(null);
	});
});

describe('admin upload — load ownerCharacter', () => {
	it('exposes hasReference true when the owner already has a designation', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values({ id: 9, title: 'Ref', slug: 'ref-9', imageUrl: 'https://cdn.example.com/9.png', artistId: 1 });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 9 });

		const data = (await load({ platform } as never)) as { ownerCharacter: { name: string; hasReference: boolean } | null };
		expect(data.ownerCharacter).toEqual({ name: 'Owner', hasReference: true });
	});

	it('exposes hasReference false when the owner has no designation', async () => {
		const { db, platform } = makeDb();
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: null });

		const data = (await load({ platform } as never)) as { ownerCharacter: { name: string; hasReference: boolean } | null };
		expect(data.ownerCharacter).toEqual({ name: 'Owner', hasReference: false });
	});

	it('returns null ownerCharacter when no owner character exists', async () => {
		const { db, platform } = makeDb();
		await db.insert(characters).values({ name: 'Featured', isOwner: false });

		const data = (await load({ platform } as never)) as { ownerCharacter: unknown };
		expect(data.ownerCharacter).toBe(null);
	});
});

describe('admin upload — load lookupEnabled (SONA-156)', () => {
	it('is false with no key anywhere', async () => {
		const { platform } = makeDb();
		const data = (await load({ platform } as never)) as { lookupEnabled: boolean };
		expect(data.lookupEnabled).toBe(false);
	});

	it('is true for a key saved in settings', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'fuzzysearchApiKey', value: 'a-saved-key' });
		const data = (await load({ platform } as never)) as { lookupEnabled: boolean };
		expect(data.lookupEnabled).toBe(true);
	});

	it('is true for the deploy secret alone', async () => {
		const { platform } = makeDb();
		const withEnv = { env: { ...platform.env, FUZZYSEARCH_API_KEY: 'from-deploy' } };
		const data = (await load({ platform: withEnv } as never)) as { lookupEnabled: boolean };
		expect(data.lookupEnabled).toBe(true);
	});

	it('is false for a key row that "Remove key" emptied', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'fuzzysearchApiKey', value: '' });
		const data = (await load({ platform } as never)) as { lookupEnabled: boolean };
		expect(data.lookupEnabled).toBe(false);
	});

	// The key read moved into the load's Promise.all, so a D1 failure on it now
	// rejects alongside the other five reads instead of after them. It still
	// rejects: the page has no artist list without those reads either, and a
	// lookupEnabled quietly forced to false would hide a broken database behind
	// a missing button. This pins today's shape so a later fold cannot change it
	// by accident.
	it('lets a failed key read reject the load rather than reporting no key', async () => {
		const { platform } = makeDb();
		const broken = { env: { ...platform.env, DB: withFailingSettingsRead(platform.env.DB) } };
		// Asserted on the helper's own wording, not on the table name drizzle
		// prints: the key read wins the rejection race either way, so a helper
		// loosened to fail every query would still satisfy a /site_settings/ pin
		// while testing something else entirely.
		const err = await Promise.resolve(load({ platform: broken } as never)).catch(
			(e: unknown) => e
		);
		// Named on the helper's own error, which drizzle keeps as the cause: the
		// message drizzle prints only names the table, and the key read wins the
		// rejection race, so /site_settings/ alone passed just as happily against
		// a helper that failed every query.
		expect(err).toBeInstanceOf(Error);
		expect(String((err as { cause?: unknown }).cause)).toContain('settings read failed');
		// And the reads beside it still answer, so what rejected was the key read
		// and not a database the helper had taken away wholesale.
		const brokenDb = drizzle(broken.env.DB, { schema });
		await expect(brokenDb.select().from(images)).resolves.toEqual([]);
	});
});
