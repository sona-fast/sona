import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { characters, images } from '$lib/server/db/schema';
import { actions } from './+page.server';

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
