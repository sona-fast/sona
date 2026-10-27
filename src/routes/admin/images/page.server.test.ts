import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { artists, characters, images } from '$lib/server/db/schema';
import { REFERENCE_BECOMES_VARIANT_ERROR } from '$lib/server/variants';
import { load, actions } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';
import { PUBLIC_WORK_TABLES } from '$lib/server/test/public-work-tables';

function makeDb() {
	const sqlite = new Database(':memory:');
	// FK enforcement is on in D1; enable it here so the reference_image_id
	// ON DELETE SET NULL behaviour is actually exercised.
	sqlite.pragma('foreign_keys = ON');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
		-- The variant actions refuse a piece linked to a commission entry (SONA-236).
		CREATE TABLE commissions (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER);
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, slug TEXT, image_url TEXT NOT NULL,
			thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER, md5hash TEXT,
			nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1, source_post_url TEXT,
			artist_id INTEGER, collection_id INTEGER, commissioned_at TEXT, parent_image_id INTEGER,
			variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE characters (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
			is_owner INTEGER NOT NULL DEFAULT 0,
			reference_image_id INTEGER REFERENCES images(id) ON DELETE SET NULL,
			created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
			global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
			aliases TEXT, avatar_resolved_at TEXT, ledger_private INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
		);
	`);
	sqlite.exec(PUBLIC_WORK_TABLES);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function form(fields: Record<string, string>): Request {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return new Request('http://localhost/admin/images', { method: 'POST', body: fd });
}

describe('admin images load — a junk ?page= serves page 1', () => {
	// Number('abc') is NaN, which reached the OFFSET and the pager.
	it('serves page 1 for ?page=abc', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values({ id: 5, title: 'Art', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1 });

		const url = new URL('http://localhost/admin/images?page=abc');
		const data = (await load({ platform, url } as never)) as unknown as { page: number; images: { id: number }[] };
		expect(data.page).toBe(1);
		expect(data.images.map((i) => i.id)).toEqual([5]);
	});
});

describe('admin images — delete action with a referenced image', () => {
	it('deletes the image and nulls the owner character reference (no FK error)', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values({ id: 5, title: 'Art', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1 });
		const [c] = await db
			.insert(characters)
			.values({ name: 'Owner', isOwner: true, referenceImageId: 5 })
			.returning({ id: characters.id });

		const result = await actions.delete({ request: form({ id: '5' }), platform } as never);
		expect(result).toEqual({ success: true });

		expect(await db.select().from(images).where(eq(images.id, 5)).get()).toBeUndefined();
		const char = await db.select({ ref: characters.referenceImageId }).from(characters).where(eq(characters.id, c.id)).get();
		expect(char?.ref).toBe(null);
	});
});

// SONA-18: /art excludes variants from its ref-sheet paths, so letting the
// designated sheet become a variant would void the reference sheet silently —
// and 404 /art outright on a fork whose only content is that sheet.
describe('admin images — grouping the designated reference sheet as a variant', () => {
	it('refuses the group and writes nothing', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values([
			{ id: 5, title: 'Ref', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1 },
			{ id: 9, title: 'Parent', slug: 'art-9', imageUrl: 'https://cdn.example.com/9.png', artistId: 1 }
		]);
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		const result = await actions.groupVariants({ request: form({ parentId: '9', ids: '5,9' }), platform } as never);
		expect((result as { status: number }).status).toBe(400);
		// Pin the message, not just the status: the neighbouring variant errors
		// would keep a status-only assertion green while losing the one line that
		// tells the operator how to proceed.
		expect((result as { data: { error: string } }).data.error).toBe(REFERENCE_BECOMES_VARIANT_ERROR);
		expect((await db.select({ p: images.parentImageId }).from(images).where(eq(images.id, 5)).get())?.p).toBe(null);
	});

	// SONA-236: a piece linked to a commission entry stays a parent, so Add to
	// gallery always adds variants to a parent.
	it('refuses to group a piece linked to a commission entry as a variant', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values([
			{ id: 5, title: 'Snowfall', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1 },
			{ id: 8, title: 'Other', slug: 'art-8', imageUrl: 'https://cdn.example.com/8.png', artistId: 1 },
			{ id: 9, title: 'Parent', slug: 'art-9', imageUrl: 'https://cdn.example.com/9.png', artistId: 1 }
		]);
		await db.run(sql`INSERT INTO commissions (image_id) VALUES (5)`);

		const result = (await actions.groupVariants({
			request: form({ parentId: '9', ids: '5,8,9' }),
			platform
		} as never)) as { status: number; data: { error: string } };
		expect(result.status).toBe(400);
		expect(result.data.error).toBe(
			"Snowfall is linked to a commission entry, so it can't become a variant. Pick it as the parent, or leave it out of the group."
		);
		// Nothing regrouped, not even the unlinked image beside it.
		const parents = await db.select({ id: images.id, p: images.parentImageId }).from(images);
		expect(parents.every((r) => r.p === null)).toBe(true);

		// Picked as the parent, the linked piece groups fine.
		expect(await actions.groupVariants({ request: form({ parentId: '5', ids: '5,8' }), platform } as never)).toEqual({
			success: true
		});
	});

	it('still groups images that are not the reference sheet', async () => {
		const { db, platform } = makeDb();
		await db.insert(images).values([
			{ id: 5, title: 'Ref', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1 },
			{ id: 8, title: 'Other', slug: 'art-8', imageUrl: 'https://cdn.example.com/8.png', artistId: 1 },
			{ id: 9, title: 'Parent', slug: 'art-9', imageUrl: 'https://cdn.example.com/9.png', artistId: 1 }
		]);
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		const result = await actions.groupVariants({ request: form({ parentId: '9', ids: '8,9' }), platform } as never);
		expect(result).toEqual({ success: true });
		expect((await db.select({ p: images.parentImageId }).from(images).where(eq(images.id, 8)).get())?.p).toBe(9);
	});
});

// SONA-236: publishing a piece by a Keep private artist asks first.
describe('admin images — togglePublished with a Keep private artist', () => {
	async function seed(db: ReturnType<typeof makeDb>['db'], image: { published: boolean; parentImageId?: number }) {
		await db.insert(artists).values({ id: 1, name: 'Quill', ledgerPrivate: true });
		await db.insert(images).values([
			{ id: 9, title: 'Parent', slug: 'art-9', imageUrl: 'https://cdn.example.com/9.png', artistId: 1, published: false },
			{ id: 5, title: 'Art', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1, ...image }
		]);
	}
	const published = async (db: ReturnType<typeof makeDb>['db']) =>
		(await db.select({ p: images.published }).from(images).where(eq(images.id, 5)).get())?.p;
	const isPrivate = async (db: ReturnType<typeof makeDb>['db']) =>
		(await db.select({ p: artists.ledgerPrivate }).from(artists).where(eq(artists.id, 1)).get())?.p;

	it('refuses without confirmUnhide and leaves the piece unpublished', async () => {
		const { db, platform } = makeDb();
		await seed(db, { published: false });

		const result = await actions.togglePublished({ request: form({ id: '5' }), platform } as never);
		expect(result).toMatchObject({ status: 409, data: { confirmUnhide: ['Quill'] } });
		expect(await published(db)).toBe(false);
		expect(await isPrivate(db)).toBe(true);
	});

	it('publishes with confirmUnhide=1 and clears Keep private', async () => {
		const { db, platform } = makeDb();
		await seed(db, { published: false });

		const result = await actions.togglePublished({ request: form({ id: '5', confirmUnhide: '1' }), platform } as never);
		expect(result).toEqual({ success: true });
		expect(await published(db)).toBe(true);
		expect(await isPrivate(db)).toBe(false);
	});

	it('asks before publishing a variant too, since its page is served', async () => {
		const { db, platform } = makeDb();
		await seed(db, { published: false, parentImageId: 9 });

		const refused = await actions.togglePublished({ request: form({ id: '5' }), platform } as never);
		expect(refused).toMatchObject({ status: 409, data: { confirmUnhide: ['Quill'] } });
		expect(await published(db)).toBe(false);
		expect(await isPrivate(db)).toBe(true);

		const result = await actions.togglePublished({ request: form({ id: '5', confirmUnhide: '1' }), platform } as never);
		expect(result).toEqual({ success: true });
		expect(await published(db)).toBe(true);
		expect(await isPrivate(db)).toBe(false);
	});

	it('unpublishes without asking', async () => {
		const { db, platform } = makeDb();
		await seed(db, { published: true });

		const result = await actions.togglePublished({ request: form({ id: '5' }), platform } as never);
		expect(result).toEqual({ success: true });
		expect(await published(db)).toBe(false);
		expect(await isPrivate(db)).toBe(true);
	});
});
