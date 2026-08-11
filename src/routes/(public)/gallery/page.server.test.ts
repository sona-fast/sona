import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { sql as sqlq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { artists, images } from '$lib/server/db/schema';
import { clearStickerTabCache } from '$lib/server/stickers';
import { clearVrTabCache } from '$lib/server/vr-gate';
import { clearFursuitPhotosCache } from '$lib/server/fursuit-import';

import { load } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

// Only the tables the gallery load reads. Columns limited to what the load's
// queries reference. `envExtra` layers extra env vars (e.g. FURTRACK_MODE)
// onto the platform for the fursuit-gating cases.
function makeDb(envExtra: Record<string, string> = {}) {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
			global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
			aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL
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
		CREATE TABLE vr_avatars (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
	`);
	const d1 = makeD1(sqlite);
	return {
		db: drizzle(d1, { schema }),
		platform: { env: { DB: d1, ...envExtra } } as unknown as App.Platform
	};
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
	fursuitEnabled: boolean;
	vrEnabled: boolean;
	stickersEnabled: boolean;
};

async function loadData(platform: App.Platform, query = ''): Promise<GalleryData> {
	// The tab probes cache per-isolate; clear them so each load sees the
	// current DB (the matrices below re-query after seeding).
	clearStickerTabCache();
	clearVrTabCache();
	clearFursuitPhotosCache();
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

describe('gallery load — VR Avatars tab visibility', () => {
	it('hides the tab with zero published avatars', async () => {
		const { platform } = makeDb();
		const data = await loadData(platform);
		expect(data.vrEnabled).toBe(false);
	});

	it('shows the tab once a published avatar exists, but not for drafts', async () => {
		const { db, platform } = makeDb();
		// draft only -> still hidden
		await db.run(sqlq`INSERT INTO vr_avatars (published) VALUES (0)`);
		expect((await loadData(platform)).vrEnabled).toBe(false);
		// published -> shown
		await db.run(sqlq`INSERT INTO vr_avatars (published) VALUES (1)`);
		expect((await loadData(platform)).vrEnabled).toBe(true);
	});
});

describe('gallery load — degraded fallback', () => {
	it('keeps the REAL vr/stickers flags on a healthy-content fork', async () => {
		const { db, platform } = makeDb();
		// The tab probes run OUTSIDE the gallery cap, so a degraded build on a
		// fork with published content keeps its tab bar. (No FURTRACK_MODE here,
		// so fursuitEnabled stays false via its env half, not the probe.)
		await db.run(sqlq`INSERT INTO vr_avatars (published) VALUES (1)`);
		await db.run(sqlq`INSERT INTO sticker_packs (published) VALUES (1)`);
		// Force build() to reject (withTimeout falls back on rejection as well as
		// timeout): its first query reads artists, so dropping that table degrades
		// the load without waiting out the 9s cap.
		await db.run(sqlq`DROP TABLE artists`);

		const data = await loadData(platform);
		expect(data.degraded).toBe(true);
		expect(data.fursuitEnabled).toBe(false);
		expect(data.stickersEnabled).toBe(true);
		expect(data.vrEnabled).toBe(true);
	});

	it('keeps the Fursuit tab on a degraded fursuit-only fork (bounded probe, not build())', async () => {
		const { db, platform } = makeDb({ FURTRACK_MODE: 'mock' });
		await db.run(sqlq`INSERT INTO fursuit_photos (id) VALUES (1)`);
		await db.run(sqlq`DROP TABLE artists`);

		const data = await loadData(platform);
		expect(data.degraded).toBe(true);
		expect(data.fursuitEnabled).toBe(true);
	});

	it('fails CLOSED when the fursuit probe itself errors (a dead Fursuit tab has no page behind it)', async () => {
		const { db, platform } = makeDb({ FURTRACK_MODE: 'mock' });
		await db.run(sqlq`DROP TABLE fursuit_photos`); // the probe's read now rejects
		await db.run(sqlq`DROP TABLE artists`);

		const data = await loadData(platform);
		expect(data.degraded).toBe(true);
		expect(data.fursuitEnabled).toBe(false);
	});

	it('still suppresses every pill on a genuine zero-content fork', async () => {
		const { db, platform } = makeDb();
		await db.run(sqlq`DROP TABLE artists`);

		const data = await loadData(platform);
		expect(data.degraded).toBe(true);
		expect(data.fursuitEnabled).toBe(false);
		expect(data.stickersEnabled).toBe(false);
		expect(data.vrEnabled).toBe(false);
	});
});

describe('gallery load — Fursuit tab visibility (healthy path reuses the bounded probe)', () => {
	it('shows the tab only when the feature is on AND photos exist', async () => {
		// Feature off (no FURTRACK_MODE) hides the tab even with photos stored.
		const off = makeDb();
		await off.db.run(sqlq`INSERT INTO fursuit_photos (id) VALUES (1)`);
		expect((await loadData(off.platform)).fursuitEnabled).toBe(false);

		// Feature on but no photos: still hidden.
		const empty = makeDb({ FURTRACK_MODE: 'mock' });
		expect((await loadData(empty.platform)).fursuitEnabled).toBe(false);

		// Feature on and a photo exists: shown (and the load stays healthy).
		const on = makeDb({ FURTRACK_MODE: 'mock' });
		await on.db.run(sqlq`INSERT INTO fursuit_photos (id) VALUES (1)`);
		const data = await loadData(on.platform);
		expect(data.degraded).toBe(false);
		expect(data.fursuitEnabled).toBe(true);
	});
});

describe('gallery load — Stickers tab visibility', () => {
	it('hides the tab with zero published packs', async () => {
		const { platform } = makeDb();
		const data = await loadData(platform);
		expect(data.stickersEnabled).toBe(false);
	});

	it('shows the tab once a published pack exists, but not for drafts', async () => {
		const { db, platform } = makeDb();
		// draft only -> still hidden
		await db.run(sqlq`INSERT INTO sticker_packs (published) VALUES (0)`);
		expect((await loadData(platform)).stickersEnabled).toBe(false);
		// published -> shown
		await db.run(sqlq`INSERT INTO sticker_packs (published) VALUES (1)`);
		expect((await loadData(platform)).stickersEnabled).toBe(true);
	});
});
