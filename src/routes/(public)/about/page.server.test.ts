import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { characters, images, siteSettings } from '$lib/server/db/schema';
import { clearSettingsCache } from '$lib/server/settings';
import { load } from './+page.server';

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
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE conventions (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location TEXT,
			start_date TEXT NOT NULL, end_date TEXT, url TEXT, status TEXT NOT NULL DEFAULT 'confirmed',
			source_id TEXT, created_at TEXT NOT NULL DEFAULT ''
		);
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

const AVATAR = 'https://cdn.bsky.app/avatar.jpg';
const REF_URL = 'https://cdn.example.com/ref-sheet.png';

beforeEach(() => {
	clearSettingsCache();
	// A configured Bluesky handle is the fallback path; a successful fetch returns
	// AVATAR, so any test where the reference image loses will surface it.
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ avatar: AVATAR }), { status: 200 })));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function seed(db: ReturnType<typeof makeDb>['db'], opts: { referenceImageId: number | null; published?: boolean }) {
	await db.insert(siteSettings).values({ key: 'blueskyUrl', value: 'https://bsky.app/profile/owner.test' });
	if (opts.referenceImageId !== null) {
		await db
			.insert(images)
			.values({ id: opts.referenceImageId, title: 'Ref', slug: 'ref', imageUrl: REF_URL, artistId: 1, published: opts.published ?? true });
	}
	await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: opts.referenceImageId });
}

describe('about load — reference image vs bluesky avatar', () => {
	it('prefers a published reference image and skips the avatar fetch', async () => {
		const { db, platform } = makeDb();
		await seed(db, { referenceImageId: 7, published: true });

		const data = (await load({ platform } as never)) as { avatarUrl: string | null };
		expect(data.avatarUrl).toContain(REF_URL);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('falls back to the bluesky avatar when referenceImageId is NULL', async () => {
		const { db, platform } = makeDb();
		await seed(db, { referenceImageId: null });

		const data = (await load({ platform } as never)) as { avatarUrl: string | null };
		expect(data.avatarUrl).toBe(AVATAR);
		expect(fetch).toHaveBeenCalled();
	});

	it('falls back to the bluesky avatar when the reference image is unpublished', async () => {
		const { db, platform } = makeDb();
		await seed(db, { referenceImageId: 7, published: false });

		const data = (await load({ platform } as never)) as { avatarUrl: string | null };
		expect(data.avatarUrl).toBe(AVATAR);
		expect(fetch).toHaveBeenCalled();
	});
});
