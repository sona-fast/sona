import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { characters, images } from '$lib/server/db/schema';
import { load, actions } from './+page.server';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses,
// same approach as admin/characters/page.server.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: any): D1Database {
	function exec(sql: string, params: unknown[], mode: 'run' | 'all' | 'raw') {
		const stmt = sqlite.prepare(sql);
		if (mode === 'raw') {
			try {
				return stmt.raw(true).all(...params) as unknown[];
			} finally {
				stmt.raw(false);
			}
		}
		if (stmt.reader) return { results: stmt.all(...params), success: true, meta: {} };
		const info = stmt.run(...params);
		return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
	}
	function prepare(sql: string) {
		return {
			bind: (...params: unknown[]) => ({
				run: () => exec(sql, params, 'run'),
				all: () => exec(sql, params, 'all'),
				raw: () => exec(sql, params, 'raw')
			})
		};
	}
	return { prepare } as unknown as D1Database;
}

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
			bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT, patreon_url TEXT,
			instagram_url TEXT, global_id TEXT, registry_version INTEGER, registry_synced_at TEXT, aliases TEXT,
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
			variant_label TEXT, created_at TEXT NOT NULL DEFAULT ''
		);
	`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

// Both the reference and save actions end in a return value or a redirect(302)
// (which throws); swallow the redirect so the test can assert the DB state.
async function callAction(fn: () => Promise<unknown>) {
	try {
		return await fn();
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e && 'location' in e) return e;
		throw e;
	}
}

function form(fields: Record<string, string>): Request {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return new Request('http://localhost/admin/images/5/edit', { method: 'POST', body: fd });
}

async function refOf(db: ReturnType<typeof makeDb>['db'], id: number) {
	const row = await db.select({ ref: characters.referenceImageId }).from(characters).where(eq(characters.id, id)).get();
	return row?.ref ?? null;
}

async function seedImage(db: ReturnType<typeof makeDb>['db'], id: number, published = true) {
	await db.insert(images).values({ id, title: 'Art', slug: `art-${id}`, imageUrl: `https://cdn.example.com/${id}.png`, artistId: 1, published });
}

describe('admin image edit — reference action', () => {
	it('sets the owner character reference image to this image', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 5);
		const [c] = await db.insert(characters).values({ name: 'Owner', isOwner: true }).returning({ id: characters.id });

		await actions.reference({ params: { id: '5' }, request: form({}), platform } as never);
		expect(await refOf(db, c.id)).toBe(5);
	});

	it('clears the reference image when clear is set', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 5);
		const [c] = await db
			.insert(characters)
			.values({ name: 'Owner', isOwner: true, referenceImageId: 5 })
			.returning({ id: characters.id });

		await actions.reference({ params: { id: '5' }, request: form({ clear: 'on' }), platform } as never);
		expect(await refOf(db, c.id)).toBe(null);
	});

	it('fails 404 and writes nothing when the image does not exist', async () => {
		const { db, platform } = makeDb();
		const [c] = await db.insert(characters).values({ name: 'Owner', isOwner: true }).returning({ id: characters.id });

		const result = await actions.reference({ params: { id: '999' }, request: form({}), platform } as never);
		expect((result as { status: number }).status).toBe(404);
		expect(await refOf(db, c.id)).toBe(null);
	});

	it('fails and writes nothing when there is no owner character', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 5);
		const [c] = await db.insert(characters).values({ name: 'Featured', isOwner: false }).returning({ id: characters.id });

		const result = await actions.reference({ params: { id: '5' }, request: form({}), platform } as never);
		expect((result as { status: number }).status).toBe(400);
		expect(await refOf(db, c.id)).toBe(null);
	});
});

describe('admin image edit — save action', () => {
	it('updates the image and redirects', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 5);

		const result = await callAction(() =>
			actions.save({ params: { id: '5' }, request: form({ title: 'Renamed', artistId: '1' }), platform } as never)
		);
		expect((result as { status: number }).status).toBe(302);
		const row = await db.select({ title: images.title }).from(images).where(eq(images.id, 5)).get();
		expect(row?.title).toBe('Renamed');
	});
});

describe('admin image edit — load ownerCharacter', () => {
	it('marks isReference true when the owner reference points at this image', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 5);
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		const data = (await load({ params: { id: '5' }, platform } as never)) as {
			ownerCharacter: { name: string; isReference: boolean } | null;
		};
		expect(data.ownerCharacter).toEqual({ name: 'Owner', isReference: true });
	});

	it('marks isReference false when the owner reference points elsewhere', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 5);
		await seedImage(db, 6);
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 6 });

		const data = (await load({ params: { id: '5' }, platform } as never)) as {
			ownerCharacter: { name: string; isReference: boolean } | null;
		};
		expect(data.ownerCharacter).toEqual({ name: 'Owner', isReference: false });
	});

	it('returns null ownerCharacter when no owner character exists', async () => {
		const { db, platform } = makeDb();
		await seedImage(db, 5);
		await db.insert(characters).values({ name: 'Featured', isOwner: false });

		const data = (await load({ params: { id: '5' }, platform } as never)) as {
			ownerCharacter: unknown;
		};
		expect(data.ownerCharacter).toBe(null);
	});
});
