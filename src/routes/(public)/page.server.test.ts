import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { characters, images, artists, tags, imageTags, siteSettings } from '$lib/server/db/schema';
import { clearSettingsCache } from '$lib/server/settings';
import { clearStickerTabCache } from '$lib/server/stickers';
import { clearCollectionsNavCache } from '$lib/server/collections';
import { load } from './+page.server';
import { load as artLoad } from '../(paths)/art/+page.server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
			bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT, patreon_url TEXT,
			instagram_url TEXT, global_id TEXT, registry_version INTEGER, registry_synced_at TEXT, aliases TEXT, avatar_resolved_at TEXT,
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
			variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE collections (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL,
			cover_image_url TEXT, created_at TEXT NOT NULL DEFAULT ''
		);
	`);
	const d1 = makeD1(sqlite);
	return { sqlite, db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function loadSplash(platform: App.Platform) {
	// The nav-probe caches are per-isolate; clear them so each load sees the
	// current DB (the flag tests below re-query after seeding).
	clearStickerTabCache();
	clearCollectionsNavCache();
	return load({ platform, url: new URL('http://example.ink/') } as never) as Promise<{
		settings: { landingLayout: string };
		pathPresence: { art: boolean; share: boolean };
		stickersEnabled: boolean;
		collectionsEnabled: boolean;
	}>;
}

beforeEach(() => clearSettingsCache());

describe('homepage load — settings payload', () => {
	// Behavioral twin of the layout's strip test: the homepage returns settings
	// independently of the layout, so it needs its own proof that a fork's /ai
	// override never rides the busiest page on the site.
	it('never ships the /ai override text', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare("INSERT INTO site_settings (key, value) VALUES ('aiPageText', ?)")
			.run('Retired override copy.');

		const data = (await loadSplash(platform)) as unknown as {
			settings: Record<string, unknown>;
		};

		expect(data.settings).not.toHaveProperty('aiPageText');
		expect(JSON.stringify(data)).not.toContain('Retired override copy.');
	});

	// This load has TWO return sites — the threePath landing and the mosaic
	// default — and a source pin only needs one match per file, so each branch
	// needs its own proof or a strip could be dropped from one silently.
	it('never ships the /ai override text on the threePath landing either', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare("INSERT INTO site_settings (key, value) VALUES ('aiPageText', ?)")
			.run('Retired override copy.');
		sqlite
			.prepare("INSERT INTO site_settings (key, value) VALUES ('landingLayout', 'threePath')")
			.run();

		const data = (await loadSplash(platform)) as unknown as {
			settings: Record<string, unknown>;
		};

		expect(data.settings.landingLayout).toBe('threePath');
		expect(data.settings).not.toHaveProperty('aiPageText');
		expect(JSON.stringify(data)).not.toContain('Retired override copy.');
	});
});

describe('splash load — pathPresence card flags (#42)', () => {
	it('hides both gated cards on an empty fork', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'landingLayout', value: 'threePath' });

		const data = await loadSplash(platform);
		expect(data.pathPresence).toEqual({ art: false, share: false });
	});

	it('shows the /art card with only a reference-tagged image', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'landingLayout', value: 'threePath' });
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		// NSFW so the recent-SFW-art probe can't be what flips the flag.
		await db.insert(images).values({ id: 1, title: 'Ref', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, nsfw: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 1, tagId: 1 });

		const data = await loadSplash(platform);
		expect(data.pathPresence).toEqual({ art: true, share: false });
	});

	it('shows the /art card with only a designated reference image', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'landingLayout', value: 'threePath' });
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({ id: 1, title: 'Ref', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, nsfw: true, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 1 });

		const data = await loadSplash(platform);
		expect(data.pathPresence).toEqual({ art: true, share: false });
	});

	it('hides the /art card when the only image — reference-tagged AND owner-designated — is unpublished', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'landingLayout', value: 'threePath' });
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(tags).values({ id: 1, name: 'reference' });
		// SFW + unpublished: dropping eq(published, true) from ANY of the three
		// probes (designated, tagged, recent-SFW) would false-positive on this row.
		await db.insert(images).values({ id: 1, title: 'Ref', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: false, nsfw: false, createdAt: '2026-01-01T00:00:00.000Z' });
		await db.insert(imageTags).values({ imageId: 1, tagId: 1 });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 1 });

		const data = await loadSplash(platform);
		expect(data.pathPresence).toEqual({ art: false, share: false });
	});

	it('hides the /art card when the only image is published NSFW and untagged', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'landingLayout', value: 'threePath' });
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		// No tag rows and no owner character: only the recent-art probe sees this
		// image, and dropping eq(nsfw, false) from it would false-positive.
		await db.insert(images).values({ id: 1, title: 'Art', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, nsfw: true, createdAt: '2026-01-01T00:00:00.000Z' });

		const data = await loadSplash(platform);
		expect(data.pathPresence).toEqual({ art: false, share: false });
	});

	it('shows the /art card with only recent SFW art', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'landingLayout', value: 'threePath' });
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		await db.insert(images).values({ id: 1, title: 'Art', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, createdAt: '2026-01-01T00:00:00.000Z' });

		const data = await loadSplash(platform);
		expect(data.pathPresence).toEqual({ art: true, share: false });
	});

	it('uses the name-first owner for the designated-ref probe, agreeing with the /art load', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'landingLayout', value: 'threePath' });
		await db.insert(artists).values({ id: 1, name: 'Artist' });
		// NSFW + untagged: only the designated-ref probe can flip the flag.
		await db.insert(images).values({ id: 1, title: 'Ref', slug: 'art-1', imageUrl: 'https://cdn.example.com/1.png', artistId: 1, published: true, nsfw: true, createdAt: '2026-01-01T00:00:00.000Z' });
		// Ref-less owner inserted FIRST so a probe that regresses to rowid order
		// (dropping orderBy(name)) would pick it and miss the designation.
		await db.insert(characters).values({ name: 'Zeta', isOwner: true, referenceImageId: null });
		await db.insert(characters).values({ name: 'Alpha', isOwner: true, referenceImageId: 1 });

		const data = await loadSplash(platform);
		expect(data.pathPresence).toEqual({ art: true, share: false });

		// Probe⟺page agreement: the /art load must resolve (not 404) on the same data.
		const artData = (await artLoad({ platform } as never)) as { refSheet: { slug: string } | null };
		expect(artData.refSheet?.slug).toBe('art-1');
	});

	it('shows the /art card with only sona details (no image queries needed)', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values([
			{ key: 'landingLayout', value: 'threePath' },
			{ key: 'sonaSpecies', value: 'Dragon' }
		]);

		const data = await loadSplash(platform);
		expect(data.pathPresence).toEqual({ art: true, share: false });
	});

	it('returns the nav-gating flags for the Header/MobileNav this page renders itself', async () => {
		// +page@ escapes the (public) layout, so ITS load must carry the same
		// flags that layout plumbs on every other public page.
		const { sqlite, db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'landingLayout', value: 'threePath' });

		let data = await loadSplash(platform);
		expect(data.stickersEnabled).toBe(false);
		expect(data.collectionsEnabled).toBe(false);

		sqlite.prepare('INSERT INTO sticker_packs (published) VALUES (1)').run();
		sqlite.prepare("INSERT INTO collections (name, slug) VALUES ('C', 'c')").run();
		data = await loadSplash(platform);
		expect(data.stickersEnabled).toBe(true);
		expect(data.collectionsEnabled).toBe(true);
	});

	it('returns the nav-gating flags on the mosaic branch too (landingLayout at its default)', async () => {
		// No landingLayout row → the default 'mosaic' branch, whose Header/
		// MobileNav renders take the same flags as the splash branch's.
		const { sqlite, platform } = makeDb();

		let data = await loadSplash(platform);
		expect(data.settings.landingLayout).toBe('mosaic');
		expect(data.stickersEnabled).toBe(false);
		expect(data.collectionsEnabled).toBe(false);

		sqlite.prepare('INSERT INTO sticker_packs (published) VALUES (1)').run();
		sqlite.prepare("INSERT INTO collections (name, slug) VALUES ('C', 'c')").run();
		data = await loadSplash(platform);
		expect(data.stickersEnabled).toBe(true);
		expect(data.collectionsEnabled).toBe(true);
	});

	it('shows the /share card with only a contact email', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values([
			{ key: 'landingLayout', value: 'threePath' },
			{ key: 'contactEmail', value: 'hi@example.ink' }
		]);

		const data = await loadSplash(platform);
		expect(data.pathPresence).toEqual({ art: false, share: true });
	});

	it('fails OPEN (both cards shown) when the presence probes hit a D1 failure', async () => {
		// Warm the settings cache so the splash branch is reached, then swap in a
		// failing D1 — the probes reject, and unlike the target pages' gates
		// (which surface the error), the splash must show the cards.
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'landingLayout', value: 'threePath' });
		await loadSplash(platform);

		const failingD1 = {
			prepare: () => {
				throw new Error('D1_ERROR: transient');
			}
		} as unknown as D1Database;
		const failingPlatform = { env: { DB: failingD1 } } as unknown as App.Platform;

		const data = await loadSplash(failingPlatform);
		// Guard against passing vacuously via the mosaic branch (which hardcodes
		// pathPresence true): the cached settings must keep us on threePath.
		expect(data.settings.landingLayout).toBe('threePath');
		expect(data.pathPresence).toEqual({ art: true, share: true });
	});
});
