import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { artists, images } from '$lib/server/db/schema';

import { load } from './+page.server';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses,
// same approach as admin/artists/page.server.test.ts.
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

// Only the tables the gallery load reads. Columns limited to what the load's
// queries reference.
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
			global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
			aliases TEXT, created_at TEXT NOT NULL
		);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL,
			image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER,
			file_size INTEGER, md5hash TEXT, nsfw INTEGER NOT NULL DEFAULT 0,
			published INTEGER NOT NULL DEFAULT 1, source_post_url TEXT, artist_id INTEGER NOT NULL,
			collection_id INTEGER, commissioned_at TEXT, parent_image_id INTEGER,
			variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER,
			created_at TEXT NOT NULL
		);
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
		CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, is_owner INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE image_characters (image_id INTEGER NOT NULL, character_id INTEGER NOT NULL);
		CREATE TABLE fursuit_photos (id INTEGER PRIMARY KEY AUTOINCREMENT);
	`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

const NOW = '2026-01-01T00:00:00.000Z';

function addArtist(db: ReturnType<typeof makeDb>['db'], name: string, aliases?: string) {
	return db.insert(artists).values({ name, aliases: aliases ?? null }).returning({ id: artists.id });
}

function addImage(
	db: ReturnType<typeof makeDb>['db'],
	opts: { artistId: number; published?: boolean; parentImageId?: number }
) {
	return db.insert(images).values({
		title: 'art',
		slug: `slug-${Math.random().toString(36).slice(2)}`,
		imageUrl: 'https://example.com/a.png',
		published: opts.published ?? true,
		artistId: opts.artistId,
		parentImageId: opts.parentImageId ?? null,
		createdAt: NOW
	});
}

function loadEvent(platform: App.Platform, query = '') {
	return { platform, url: new URL(`http://localhost/gallery${query}`) } as never;
}

// load's PageServerLoad signature widens the return to `void | …`; narrow to the
// fields these tests read (same cast approach as admin/artists/page.server.test.ts).
type GalleryData = {
	artists: { name: string; formerly?: string[] }[];
	formerName: { searched: string; current: string } | null;
	filters: { artist: string };
	images: unknown[];
	degraded: boolean;
};

async function loadData(platform: App.Platform, query = ''): Promise<GalleryData> {
	return (await load(loadEvent(platform, query))) as GalleryData;
}

describe('gallery load — artist combobox lists only live artists', () => {
	it('includes an artist with a published, non-variant image', async () => {
		const { db, platform } = makeDb();
		const [{ id }] = await addArtist(db, 'Kestrel');
		await addImage(db, { artistId: id, published: true });

		const data = await loadData(platform);
		expect(data.artists.map((a) => a.name)).toContain('Kestrel');
	});

	it('excludes an artist whose only image is unpublished', async () => {
		const { db, platform } = makeDb();
		const [{ id }] = await addArtist(db, 'Draft');
		await addImage(db, { artistId: id, published: false });

		const data = await loadData(platform);
		expect(data.artists.map((a) => a.name)).not.toContain('Draft');
	});

	it('excludes an artist with zero images (imported-but-unused / sticker-only)', async () => {
		const { db, platform } = makeDb();
		await addArtist(db, 'Ghost');

		const data = await loadData(platform);
		expect(data.artists.map((a) => a.name)).not.toContain('Ghost');
	});

	it("excludes an artist whose only published image is a variant (never a standalone card)", async () => {
		const { db, platform } = makeDb();
		const [{ id }] = await addArtist(db, 'VariantOnly');
		const [{ id: parentId }] = await addImage(db, { artistId: id, published: false }).returning({
			id: images.id
		});
		await addImage(db, { artistId: id, published: true, parentImageId: parentId });

		const data = await loadData(platform);
		expect(data.artists.map((a) => a.name)).not.toContain('VariantOnly');
	});

	it('includes an artist who has both a published standalone AND a published variant', async () => {
		const { db, platform } = makeDb();
		const [{ id }] = await addArtist(db, 'Mixed');
		const [{ id: parentId }] = await addImage(db, { artistId: id, published: true }).returning({
			id: images.id
		});
		await addImage(db, { artistId: id, published: true, parentImageId: parentId });

		const data = await loadData(platform);
		expect(data.artists.map((a) => a.name)).toContain('Mixed');
	});
});

describe('gallery load — former-name (alias) resolution', () => {
	it('resolves an alias of a live artist to their current name', async () => {
		const { db, platform } = makeDb();
		const [{ id }] = await addArtist(
			db,
			'Kestrel',
			JSON.stringify([{ displayName: 'KesForge', socials: {} }])
		);
		await addImage(db, { artistId: id, published: true });

		const data = await loadData(platform, '?artist=KesForge');
		expect(data.formerName).toEqual({ searched: 'KesForge', current: 'Kestrel' });
		expect(data.filters.artist).toBe('Kestrel');
		expect(data.images).toHaveLength(1);
	});

	it('leaves ?artist= for a non-live artist as an empty grid without crashing', async () => {
		const { db, platform } = makeDb();
		const [{ id }] = await addArtist(db, 'Draft');
		await addImage(db, { artistId: id, published: false });

		const data = await loadData(platform, '?artist=Draft');
		expect(data.formerName).toBeNull();
		expect(data.filters.artist).toBe('Draft');
		expect(data.images).toHaveLength(0);
		expect(data.degraded).toBe(false);
	});

	it('never hijacks a real current name with no live work into another artist via an alias', async () => {
		// Repro: current artist "Draft" has no live work (exactly the population the
		// combobox now hides), and a DIFFERENT live artist "Phoenix" lists "Draft" as
		// a former name. ?artist=Draft must NOT resolve to Phoenix (that would show
		// Phoenix's work under a false "formerly Draft" banner) — the name-existence
		// check runs against the unfiltered artist set.
		const { db, platform } = makeDb();
		const [{ id: draftId }] = await addArtist(db, 'Draft');
		await addImage(db, { artistId: draftId, published: false });
		const [{ id: phoenixId }] = await addArtist(
			db,
			'Phoenix',
			JSON.stringify([{ displayName: 'Draft', socials: {} }])
		);
		await addImage(db, { artistId: phoenixId, published: true });

		const data = await loadData(platform, '?artist=Draft');
		expect(data.formerName).toBeNull();
		expect(data.filters.artist).toBe('Draft');
		expect(data.images).toHaveLength(0);
		expect(data.degraded).toBe(false);
	});

	it('does not resolve a former name claimed only by a non-live artist', async () => {
		// "OldGhost" is an alias of "Ghost", who has no live work — so Ghost is absent
		// from the live-only alias-candidate set and the former name stays unresolved.
		const { db, platform } = makeDb();
		const [{ id }] = await addArtist(
			db,
			'Ghost',
			JSON.stringify([{ displayName: 'OldGhost', socials: {} }])
		);
		await addImage(db, { artistId: id, published: false });

		const data = await loadData(platform, '?artist=OldGhost');
		expect(data.formerName).toBeNull();
		expect(data.filters.artist).toBe('OldGhost');
		expect(data.images).toHaveLength(0);
		expect(data.degraded).toBe(false);
	});
});
