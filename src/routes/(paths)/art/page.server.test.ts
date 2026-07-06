import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { characters, images, artists, tags, imageTags, siteSettings } from '$lib/server/db/schema';
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
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
			bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT, patreon_url TEXT,
			instagram_url TEXT, global_id TEXT, registry_version INTEGER, registry_synced_at TEXT, aliases TEXT,
			created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '');
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
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

beforeEach(() => clearSettingsCache());

describe('art load — refSheet precedence', () => {
	it('prefers the explicit designation over a newer tagged image', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		// Designated (older) image, not tagged.
		await db.insert(images).values({ id: 5, title: 'Ref', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' });
		// Newer image tagged 'reference' — would win the tag query.
		await db.insert(images).values({ id: 6, title: 'Tagged', slug: 'art-6', imageUrl: 'https://cdn.example.com/6.png', artistId: 1, published: true, createdAt: '2026-06-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 6, tagId: 1 });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		const data = (await load({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(data.refSheet?.slug).toBe('art-5');
	});

	it('falls back to the tagged image when no designation is set', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values({ id: 6, title: 'Tagged', slug: 'art-6', imageUrl: 'https://cdn.example.com/6.png', artistId: 1, published: true, createdAt: '2026-06-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 6, tagId: 1 });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: null });

		const data = (await load({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(data.refSheet?.slug).toBe('art-6');
	});

	it('falls back to the tagged image when the designated image is unpublished', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values({ id: 5, title: 'Ref', slug: 'art-5', imageUrl: 'https://cdn.example.com/5.png', artistId: 1, published: false, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(images).values({ id: 6, title: 'Tagged', slug: 'art-6', imageUrl: 'https://cdn.example.com/6.png', artistId: 1, published: true, createdAt: '2026-06-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 6, tagId: 1 });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		const data = (await load({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(data.refSheet?.slug).toBe('art-6');
	});
});

describe('art load — content-presence gate (#42)', () => {
	it('404s when every content source is absent', async () => {
		const { platform } = makeDb();
		await expect(load({ platform } as never)).rejects.toMatchObject({ status: 404 });
	});

	it('loads with only a reference-tagged image', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values({ id: 1, title: 'Ref', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, nsfw: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 1, tagId: 1 });

		const data = (await load({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(data.refSheet?.slug).toBe('art-1');
	});

	it('loads with only an explicitly designated reference image', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({ id: 1, title: 'Ref', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, nsfw: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 1 });

		const data = (await load({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(data.refSheet?.slug).toBe('art-1');
	});

	it('loads with only recent art (published, untagged)', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({ id: 1, title: 'Art', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' });

		const data = (await load({ platform } as never)) as { recentArt: unknown[] };
		expect(data.recentArt).toHaveLength(1);
	});

	it('loads with only sheet details (species setting)', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'sonaSpecies', value: 'Dragon' });

		const data = (await load({ platform } as never)) as { sona: { species: string } };
		expect(data.sona.species).toBe('Dragon');
	});

	it('loads with only color swatches', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'sonaColors', value: '[{"name":"Fur","hex":"#aabbcc"}]' });

		const data = (await load({ platform } as never)) as { sona: { colors: unknown[] } };
		expect(data.sona.colors).toHaveLength(1);
	});

	it('loads with only do/don\'t lines', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'sonaDonts', value: 'No mecha' });

		const data = (await load({ platform } as never)) as { sona: { donts: string[] } };
		expect(data.sona.donts).toEqual(['No mecha']);
	});

	it('loads when fully populated', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values({ id: 1, title: 'Ref', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 1, tagId: 1 });
		await db.insert(siteSettings).values([
			{ key: 'sonaSpecies', value: 'Dragon' },
			{ key: 'sonaDos', value: 'Big wings' }
		]);

		const data = (await load({ platform } as never)) as {
			refSheet: { slug: string } | null;
			recentArt: unknown[];
			sona: { species: string; dos: string[] };
		};
		expect(data.refSheet?.slug).toBe('art-1');
		expect(data.recentArt).toHaveLength(1);
		expect(data.sona.species).toBe('Dragon');
		expect(data.sona.dos).toEqual(['Big wings']);
	});
});
