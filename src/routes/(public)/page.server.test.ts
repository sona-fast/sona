import { describe, it, expect, beforeEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { characters, images, artists, tags, imageTags, imageCharacters, siteSettings } from '$lib/server/db/schema';
import { clearSettingsCache, DEFAULTS } from '$lib/server/settings';
import { clearStickerTabCache } from '$lib/server/stickers';
import { clearCollectionsNavCache } from '$lib/server/collections';
import { load } from './+page.server';
import { load as artLoad } from '../(paths)/art/+page.server';
import { loadPassport, loadPassportPicture, type PassportData } from '$lib/server/passport';

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
		CREATE TABLE image_characters (image_id INTEGER NOT NULL, character_id INTEGER NOT NULL);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, slug TEXT, image_url TEXT NOT NULL,
			thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER, md5hash TEXT,
			nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1, source_post_url TEXT,
			artist_id INTEGER, collection_id INTEGER, commissioned_at TEXT, parent_image_id INTEGER,
			variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE stickers (id INTEGER PRIMARY KEY AUTOINCREMENT, pack_id INTEGER NOT NULL);
		CREATE TABLE vr_avatars (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE conventions (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, location TEXT, start_date TEXT NOT NULL,
			end_date TEXT, url TEXT, status TEXT NOT NULL DEFAULT 'confirmed', source_id TEXT, timezone TEXT,
			created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE fursuit_photos (
			id INTEGER PRIMARY KEY AUTOINCREMENT, furtrack_post_id INTEGER NOT NULL, character TEXT NOT NULL,
			description TEXT, image_url TEXT NOT NULL, width INTEGER, height INTEGER, photographer TEXT NOT NULL,
			photographer_url TEXT, event TEXT, license TEXT NOT NULL, permission_source TEXT,
			furtrack_url TEXT NOT NULL, taken_at TEXT, created_at TEXT NOT NULL DEFAULT ''
		);
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

type PassportPage = {
	settings: { landingLayout: string };
	passport: PassportData;
};

function loadPassportPage(platform: App.Platform) {
	clearStickerTabCache();
	clearCollectionsNavCache();
	return load({ platform, url: new URL('http://example.ink/') } as never) as Promise<PassportPage>;
}

/** makeDb with the passport layout set and FurTrack in the given mode. */
function makePassportDb(furtrackMode = 'off') {
	const made = makeDb();
	made.sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('landingLayout', 'passport')").run();
	const env = made.platform.env as unknown as Record<string, unknown>;
	env.FURTRACK_MODE = furtrackMode;
	return made;
}

function isoDay(offsetDays: number): string {
	return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const kinds = (data: PassportPage) => data.passport.stamps.features.map((f) => f.kind);

describe('passport load — counts', () => {
	it('counts published parent pieces (NSFW included), their artists, stickers, avatars and collections', async () => {
		const { sqlite, db, platform } = makePassportDb();
		await db.insert(artists).values([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
		await db.insert(images).values([
			{ id: 1, title: 'One', slug: 'one', imageUrl: '/1.png', artistId: 1, commissionedAt: '2021-05-01' },
			{ id: 2, title: 'Two', slug: 'two', imageUrl: '/2.png', artistId: 2, nsfw: true, commissionedAt: '2019-02-01' },
			{ id: 3, title: 'Three', slug: 'three', imageUrl: '/3.png', artistId: 1 },
			// An empty commissioned date is no year: MIN would pick '' over 2019.
			{ id: 6, title: 'Blank Date', slug: 'blank-date', imageUrl: '/6.png', artistId: 1, commissionedAt: '' },
			// A variant, an unpublished piece, and an unpublished piece with an older
			// commissioned date: none of them count, and the draft's year is not
			// the "since" year.
			{ id: 4, title: 'Alt', slug: 'alt', imageUrl: '/4.png', artistId: 2, parentImageId: 1 },
			{ id: 5, title: 'Draft', slug: 'draft', imageUrl: '/5.png', artistId: 2, published: false, commissionedAt: '2010-01-01' }
		]);
		sqlite.exec(`
			INSERT INTO sticker_packs (id, published) VALUES (1, 1), (2, 0);
			INSERT INTO stickers (pack_id) VALUES (1), (1), (2);
			INSERT INTO vr_avatars (published) VALUES (1), (0);
			INSERT INTO collections (name, slug) VALUES ('C1', 'c1'), ('C2', 'c2');
		`);

		const data = await loadPassportPage(platform);
		expect(data.settings.landingLayout).toBe('passport');
		expect(data.passport.stamps.features).toEqual([
			{ kind: 'gallery', href: '/gallery', counts: [4, 2] },
			{ kind: 'stickers', href: '/stickers', counts: [2, 1] },
			{ kind: 'vr', href: '/vr', counts: [1] },
			{ kind: 'collections', href: '/collections', counts: [2] }
		]);
		expect(data.passport.since).toBe('2019');
		expect(data.passport.mrz[1]).toContain('2019');
	});

	it('reads the fursuit stamp and the past-event stamps from displayable photos only while FurTrack is on', async () => {
		const seedPhotos = (sqlite: { exec: (s: string) => void }) =>
			sqlite.exec(`
				INSERT INTO fursuit_photos (furtrack_post_id, character, image_url, photographer, event, license, furtrack_url, taken_at, permission_source)
				VALUES
					(1, 'c', '/f1.jpg', 'Lens A', 'Harbourfur 2025', 'cc-by', 'https://furtrack.example/1', '2025-11-08', NULL),
					(2, 'c', '/f2.jpg', 'Lens B', 'Harbourfur 2025', 'cc-by', 'https://furtrack.example/2', '2025-11-09T10:00:00Z', NULL),
					(3, 'c', '/f3.jpg', 'Lens B', 'Pinewood Howl 2025', 'unknown', 'https://furtrack.example/3', '2025-06-14', 'DM 2025-06-20'),
					(4, 'c', '/f4.jpg', 'Lens C', 'Secret Con 2025', 'unknown', 'https://furtrack.example/4', '2025-03-01', NULL),
					(5, 'c', '/f5.jpg', 'Lens D', NULL, 'public-domain', 'https://furtrack.example/5', '2025-12-01', NULL),
					(6, 'c', '/f6.jpg', 'Lens A', '  ', 'cc-by', 'https://furtrack.example/6', '2025-12-02', NULL),
					(7, 'c', '/f7.jpg', 'Lens E', 'Hidden Con 2025', 'all-rights-reserved', 'https://furtrack.example/7', '2025-12-03', ''),
					(8, 'c', '/f8.jpg', 'Lens E', 'Odd Key Con', 'toString', 'https://furtrack.example/8', '2025-12-04', NULL);
			`);

		const on = makePassportDb('mock');
		seedPhotos(on.sqlite);
		const data = await loadPassportPage(on.platform);
		// Photos 4, 7 and 8 are not displayable and have no recorded permission
		// (an empty source is none, an unknown key is not displayable): the
		// gallery would not show them, so the passport neither counts nor names
		// their events. Photos 5 and 6 count but carry no event, so no stamp.
		expect(data.passport.stamps.features).toContainEqual({ kind: 'fursuit', href: '/gallery?view=fursuit', counts: [5, 3] });
		expect(data.passport.stamps.conventions).toEqual([
			{ kind: 'past', name: 'Harbourfur 2025', month: '2025-11', photos: 2, href: '/gallery?view=fursuit&event=Harbourfur%202025' },
			{ kind: 'past', name: 'Pinewood Howl 2025', month: '2025-06', photos: 1, href: '/gallery?view=fursuit&event=Pinewood%20Howl%202025' }
		]);

		clearSettingsCache();
		const off = makePassportDb('off');
		seedPhotos(off.sqlite);
		const offData = await loadPassportPage(off.platform);
		expect(kinds(offData)).not.toContain('fursuit');
		expect(offData.passport.stamps.conventions).toEqual([]);
	});

	// The events are grouped, ordered and limited in SQL; the limit must leave
	// room for an event named after an upcoming confirmed convention, which
	// pastEventStamps drops, so the six newest other events still fill the cap.
	it('fills the past stamps with the newest events, skipping one named after an upcoming convention', async () => {
		const { sqlite, platform } = makePassportDb('mock');
		const events = ['Con A', 'Con B', 'Con C', 'Con D', 'Con E', 'Con F', 'Con G'];
		const insert = sqlite.prepare(
			"INSERT INTO fursuit_photos (furtrack_post_id, character, image_url, photographer, event, license, furtrack_url, taken_at) VALUES (?, 'c', '/f.jpg', 'Lens', ?, 'cc-by', 'https://furtrack.example', ?)"
		);
		events.forEach((event, i) => insert.run(i + 1, event, `2025-0${i + 1}-01`));
		insert.run(100, 'Con A', '2025-01-02');
		// Tagged before it starts, and the newest date of all.
		insert.run(101, 'Future Fest', isoDay(-1));
		sqlite
			.prepare("INSERT INTO conventions (name, start_date, status, timezone) VALUES ('Future Fest', ?, 'confirmed', 'UTC')")
			.run(isoDay(30));

		const data = await loadPassportPage(platform);
		expect(data.passport.stamps.conventions.map((c) => [c.kind, c.name])).toEqual([
			['next', 'Future Fest'],
			['past', 'Con G'],
			['past', 'Con F'],
			['past', 'Con E'],
			['past', 'Con D'],
			['past', 'Con C'],
			['past', 'Con B']
		]);
		expect(data.passport.stamps.features).toContainEqual({ kind: 'fursuit', href: '/gallery?view=fursuit', counts: [9, 1] });
	});

	// A malformed date that sorts above the real ones must not become the
	// event's latest day: '2025-13-05' is no month, and '2026-02-30' is no day.
	it("takes each event's month from its valid dates, ignoring impossible ones that sort higher", async () => {
		const { sqlite, platform } = makePassportDb('mock');
		sqlite.exec(`
			INSERT INTO fursuit_photos (furtrack_post_id, character, image_url, photographer, event, license, furtrack_url, taken_at)
			VALUES
				(1, 'c', '/f1.jpg', 'Lens', 'Harbourfur 2025', 'cc-by', 'https://furtrack.example/1', '2025-11-08'),
				(2, 'c', '/f2.jpg', 'Lens', 'Harbourfur 2025', 'cc-by', 'https://furtrack.example/2', '2025-13-05'),
				(3, 'c', '/f3.jpg', 'Lens', 'Snowpaw 2026', 'cc-by', 'https://furtrack.example/3', '2026-01-10T09:00:00Z'),
				(4, 'c', '/f4.jpg', 'Lens', 'Snowpaw 2026', 'cc-by', 'https://furtrack.example/4', '2026-02-30');
		`);

		const data = await loadPassportPage(platform);
		expect(data.passport.stamps.conventions).toEqual([
			{ kind: 'past', name: 'Snowpaw 2026', month: '2026-01', photos: 2, href: '/gallery?view=fursuit&event=Snowpaw%202026' },
			{ kind: 'past', name: 'Harbourfur 2025', month: '2025-11', photos: 2, href: '/gallery?view=fursuit&event=Harbourfur%202025' }
		]);
	});

	// The group read is one row per event, so its slack is wide: more than eight
	// newer events named after confirmed conventions that have not ended still
	// leave every older event a chance at a past stamp.
	it('fills the past stamps past more than eight newer events named after upcoming conventions', async () => {
		const { sqlite, platform } = makePassportDb('mock');
		const insert = sqlite.prepare(
			"INSERT INTO fursuit_photos (furtrack_post_id, character, image_url, photographer, event, license, furtrack_url, taken_at) VALUES (?, 'c', '/f.jpg', 'Lens', ?, 'cc-by', 'https://furtrack.example', ?)"
		);
		const addCon = sqlite.prepare(
			"INSERT INTO conventions (name, start_date, status, timezone) VALUES (?, ?, 'confirmed', 'UTC')"
		);
		const past = ['Con A', 'Con B', 'Con C', 'Con D', 'Con E', 'Con F'];
		past.forEach((event, i) => insert.run(i + 1, event, `2025-0${i + 1}-01`));
		for (let i = 0; i < 9; i++) {
			insert.run(100 + i, `Future Fest ${i}`, isoDay(-1));
			addCon.run(`Future Fest ${i}`, isoDay(30 + i));
		}

		const data = await loadPassportPage(platform);
		expect(data.passport.stamps.conventions.filter((c) => c.kind === 'past').map((c) => c.name)).toEqual([
			'Con F',
			'Con E',
			'Con D',
			'Con C',
			'Con B',
			'Con A'
		]);
	});
});

describe('passport load — conventions', () => {
	it('leads with a confirmed live convention (isLiveNow) and never with a maybe', async () => {
		const { sqlite, platform } = makePassportDb();
		const insert = sqlite.prepare(
			'INSERT INTO conventions (name, location, start_date, end_date, status, timezone) VALUES (?, ?, ?, ?, ?, ?)'
		);
		insert.run('Maybe Con', 'Elsewhere', isoDay(-1), isoDay(1), 'maybe', 'UTC');
		insert.run('Live Con', 'Reno, Nevada', isoDay(-1), isoDay(1), 'confirmed', 'UTC');
		insert.run('Next Con', null, isoDay(40), isoDay(42), 'confirmed', 'UTC');
		insert.run('Considering Con', null, isoDay(20), isoDay(22), 'considering', 'UTC');
		// A confirmed convention that is over, with no fursuit photos: no stamp,
		// because /connect and /about publish only upcoming and live conventions.
		insert.run('Past Con', null, isoDay(-90), isoDay(-88), 'confirmed', 'UTC');

		const data = await loadPassportPage(platform);
		expect(data.passport.stamps.live).toEqual({
			name: 'Live Con',
			location: 'Reno, Nevada',
			until: isoDay(1),
			href: '/connect'
		});
		expect(data.passport.stamps.conventions).toEqual([
			{ kind: 'next', name: 'Next Con', startDate: isoDay(40), href: '/connect' }
		]);
		// Upcoming conventions are what /about shows, so the About stamp follows.
		expect(kinds(data)).toEqual(['about']);
	});

	// /about lists upcoming conventions of every status, so a maybe row still
	// earns the About stamp, but never Here now or Next.
	it('gives a maybe convention running today no Here now stamp, only About', async () => {
		const { sqlite, platform } = makePassportDb();
		sqlite
			.prepare('INSERT INTO conventions (name, start_date, end_date, status, timezone) VALUES (?, ?, ?, ?, ?)')
			.run('Maybe Con', isoDay(-1), isoDay(1), 'maybe', 'UTC');

		const data = await loadPassportPage(platform);
		expect(data.passport.stamps.live).toBeNull();
		expect(data.passport.stamps.conventions).toEqual([]);
		expect(data.passport.stamps.features).toEqual([
			{ kind: 'about', href: '/about', counts: [], about: 'conventions' }
		]);
	});

	it('shows About for an upcoming considering convention, and not for a past one', async () => {
		const { sqlite, platform } = makePassportDb();
		const insert = sqlite.prepare(
			'INSERT INTO conventions (name, start_date, end_date, status, timezone) VALUES (?, ?, ?, ?, ?)'
		);
		insert.run('Past Maybe', isoDay(-30), isoDay(-28), 'maybe', 'UTC');
		let data = await loadPassportPage(platform);
		expect(data.passport.hasStamps).toBe(false);

		insert.run('Considering Con', isoDay(60), isoDay(62), 'considering', 'UTC');
		data = await loadPassportPage(platform);
		expect(data.passport.stamps.features).toEqual([
			{ kind: 'about', href: '/about', counts: [], about: 'conventions' }
		]);
		expect(data.passport.stamps.conventions).toEqual([]);
	});

	// /about reads against today's UTC date with no day of slack, so a maybe or
	// considering row that ended yesterday is gone from /about, and the About
	// stamp must not point there for it.
	it('gives no About stamp for a maybe or considering convention that ended yesterday (UTC)', async () => {
		const { sqlite, platform } = makePassportDb();
		const insert = sqlite.prepare(
			'INSERT INTO conventions (name, start_date, end_date, status, timezone) VALUES (?, ?, ?, ?, ?)'
		);
		insert.run('Ended Maybe', isoDay(-3), isoDay(-1), 'maybe', 'UTC');
		insert.run('Ended Considering', isoDay(-3), isoDay(-1), 'considering', 'UTC');

		const data = await loadPassportPage(platform);
		expect(data.passport.hasStamps).toBe(false);
		expect(kinds(data)).not.toContain('about');
	});

	// The Here now read keeps /connect's day of slack, so a confirmed convention
	// whose last day is still running in Los Angeles is live, while the About
	// read, which is /about's UTC-date predicate, has already dropped it. Pinned
	// at 05:00 UTC, when it is still the previous evening in Los Angeles.
	it('keeps Here now for a con still running further west while About has dropped it', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(new Date('2026-03-10T05:00:00Z'));
			const { sqlite, platform } = makePassportDb();
			sqlite
				.prepare('INSERT INTO conventions (name, start_date, end_date, status, timezone) VALUES (?, ?, ?, ?, ?)')
				.run('West Con', '2026-03-07', '2026-03-09', 'confirmed', 'America/Los_Angeles');

			const data = await loadPassportPage(platform);
			expect(data.passport.stamps.live).toMatchObject({ name: 'West Con', until: '2026-03-09' });
			expect(kinds(data)).not.toContain('about');
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('passport load — the picture of the day', () => {
	// Noon UTC on a fixed day, so "later the same day" and "the next day" are
	// plain offsets.
	const NOON = new Date('2026-09-24T12:00:00Z');
	const at = (days: number, hours = 0) => new Date(NOON.getTime() + days * 86_400_000 + hours * 3_600_000);

	function pick(db: ReturnType<typeof makeDb>['db'], now: Date, settings = DEFAULTS) {
		return loadPassport({ db, env: undefined, settings, host: 'example.ink', now, timeoutMs: 1000 }).then(
			(p) => p.picture
		);
	}

	const seedArtist = (db: ReturnType<typeof makeDb>['db']) => db.insert(artists).values({ id: 1, name: 'mothlamp' });

	async function seedPieces(db: ReturnType<typeof makeDb>['db'], ids: number[]) {
		await seedArtist(db);
		await db
			.insert(images)
			.values(ids.map((id) => ({ id, title: `Piece ${id}`, slug: `piece-${id}`, imageUrl: `/${id}.png`, artistId: 1 })));
	}

	it('picks only published SFW parents tagged with no character or only owner characters', async () => {
		const { db } = makePassportDb();
		await seedArtist(db);
		await db.insert(characters).values([
			{ id: 1, name: 'Owner', isOwner: true },
			{ id: 2, name: 'Second Owner', isOwner: true },
			{ id: 3, name: 'Friend', isOwner: false }
		]);
		await db.insert(images).values([
			{ id: 1, title: 'Untagged', slug: 'untagged', imageUrl: '/1.png', artistId: 1 },
			{ id: 2, title: 'Owners Only', slug: 'owners-only', imageUrl: '/2.png', artistId: 1 },
			{ id: 3, title: 'NSFW', slug: 'nsfw', imageUrl: '/3.png', artistId: 1, nsfw: true },
			{ id: 4, title: 'Draft', slug: 'draft', imageUrl: '/4.png', artistId: 1, published: false },
			{ id: 5, title: 'Variant', slug: 'variant', imageUrl: '/5.png', artistId: 1, parentImageId: 1 },
			{ id: 6, title: 'Friend Only', slug: 'friend-only', imageUrl: '/6.png', artistId: 1 },
			{ id: 7, title: 'Owner And Friend', slug: 'owner-and-friend', imageUrl: '/7.png', artistId: 1 }
		]);
		await db.insert(imageCharacters).values([
			{ imageId: 2, characterId: 1 },
			{ imageId: 2, characterId: 2 },
			{ imageId: 6, characterId: 3 },
			{ imageId: 7, characterId: 1 },
			{ imageId: 7, characterId: 3 }
		]);

		const picked = new Set<string | null>();
		for (let day = 0; day < 60; day++) picked.add((await pick(db, at(day)))?.slug ?? null);
		// Over two months both eligible pieces come up, and nothing else ever does.
		expect([...picked].sort()).toEqual(['owners-only', 'untagged']);
	});

	it('credits the piece by title and artist, and never carries an NSFW flag', async () => {
		const { db } = makePassportDb();
		await seedPieces(db, [1]);
		const picture = await pick(db, NOON);
		expect(picture).toEqual({ kind: 'piece', slug: 'piece-1', imageUrl: '/1.png', title: 'Piece 1', artistName: 'mothlamp' });
	});

	it('keeps the same piece all day and moves on across days', async () => {
		const { db } = makePassportDb();
		await seedPieces(db, [1, 2, 3, 4, 5]);

		// The whole UTC day, midnight to a millisecond before the next one.
		const today = (await pick(db, NOON))?.slug;
		const midnight = new Date('2026-09-24T00:00:00Z');
		for (const now of [midnight, at(0, -6), at(0, 6), new Date('2026-09-24T23:59:59.999Z')]) {
			expect((await pick(db, now))?.slug).toBe(today);
		}

		// Two weeks of days, each stable in itself, and not all the same piece.
		const days: (string | null | undefined)[] = [];
		for (let day = 0; day < 14; day++) {
			const morning = (await pick(db, at(day, -11)))?.slug;
			expect((await pick(db, at(day, 11)))?.slug).toBe(morning);
			days.push(morning);
		}
		expect(new Set(days).size).toBeGreaterThan(1);
		expect(days.some((slug, i) => i > 0 && slug !== days[i - 1])).toBe(true);
	});

	// The rank is per piece, so publishing a piece mid-day only changes the
	// pick when the new piece outranks it; a count-and-offset pick would move
	// on every publish.
	it('leaves the pick alone when a lower-ranked piece is published mid-day', async () => {
		const { sqlite, db } = makePassportDb();
		await seedPieces(db, [1, 2, 3]);

		let unchanged = 0;
		for (let day = 0; day < 30; day++) {
			sqlite.exec('UPDATE images SET published = 0 WHERE id = 3');
			const before = (await pick(db, at(day, -1)))?.slug;
			sqlite.exec('UPDATE images SET published = 1 WHERE id = 3');
			const after = (await pick(db, at(day, 1)))?.slug;
			expect([before, 'piece-3']).toContain(after);
			if (after === before) unchanged++;
		}
		// Not vacuous: on most days the new piece does not outrank the pick.
		expect(unchanged).toBeGreaterThan(0);
	});

	// image_characters has no index on image_id, so a correlated subquery
	// rescans the whole table once per candidate piece. The owner-only filter
	// must run as a subquery SQLite evaluates once.
	it('filters out other characters without a correlated subquery', () => {
		const { sqlite, db } = makePassportDb();
		const { sql: text, params } = loadPassportPicture(db, NOON).toSQL();
		const plan = (sqlite.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...params) as { detail: string }[]).map(
			(row) => row.detail
		);
		expect(plan.some((detail) => detail.includes('image_characters'))).toBe(true);
		expect(plan.filter((detail) => detail.includes('CORRELATED'))).toEqual([]);
		// A positive check too, so a renamed plan label fails loudly instead of
		// letting a reverted correlated form pass unnoticed.
		expect(plan.some((detail) => detail.includes('LIST SUBQUERY'))).toBe(true);
	});

	// The schema allows an empty title; the picture link still needs a name,
	// so the character's name (the data page's name) stands in.
	it("titles an untitled piece with the character's name", async () => {
		const { sqlite, db, platform } = makePassportDb();
		sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('ownerName', 'Ashby')").run();
		await seedPieces(db, [1]);
		sqlite.exec("UPDATE images SET title = '   '");

		const data = await loadPassportPage(platform);
		expect(data.passport.name).toBe('Ashby');
		expect(data.passport.picture).toMatchObject({ kind: 'piece', slug: 'piece-1', title: 'Ashby' });
	});

	// The ref sheet no longer takes the passport: a designated NSFW sheet is out
	// of the pool, and a SFW one is one piece among the rest.
	it('ignores the ref sheet designation and the featured order', async () => {
		const { db } = makePassportDb();
		await seedArtist(db);
		await db.insert(images).values([
			{ id: 1, title: 'Mature Ref', slug: 'mature-ref', imageUrl: '/1.png', artistId: 1, nsfw: true },
			{ id: 2, title: 'Featured', slug: 'featured', imageUrl: '/2.png', artistId: 1, nsfw: true, featured: true, featuredOrder: 1 },
			{ id: 3, title: 'Plain', slug: 'plain', imageUrl: '/3.png', artistId: 1 }
		]);
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 1 });

		for (let day = 0; day < 7; day++) expect(await pick(db, at(day))).toMatchObject({ kind: 'piece', slug: 'plain' });
	});

	it('falls back to the admin avatar with an empty pool, and to no picture without one', async () => {
		const { sqlite, db, platform } = makePassportDb();
		await seedPieces(db, [1]);
		// Every piece out of the pool: NSFW.
		sqlite.exec('UPDATE images SET nsfw = 1');
		let data = await loadPassportPage(platform);
		expect(data.passport.picture).toBeNull();

		sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('adminAvatarUrl', '/face.png')").run();
		clearSettingsCache();
		data = await loadPassportPage(platform);
		expect(data.passport.picture).toEqual({ kind: 'avatar', imageUrl: '/face.png', slug: null, title: '', artistName: null });
	});
});

describe('passport load — empty site and degraded reads', () => {
	it('renders a fresh fork as a data page with no stamps, the host, and no default about text', async () => {
		const { sqlite, platform } = makePassportDb();
		sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('ownerName', 'Ashby')").run();

		const data = await loadPassportPage(platform);
		expect(data.passport).toMatchObject({
			name: 'Ashby',
			host: 'example.ink',
			pronouns: '',
			species: '',
			since: null,
			socials: [],
			about: '',
			hasStamps: false
		});
		expect(data.passport.stamps).toEqual({ live: null, features: [], conventions: [] });
		expect(data.passport.mrz[1].startsWith('EXAMPLE<INK<')).toBe(true);
		expect(data.passport.mrz.join('')).not.toMatch(/\d/);
	});

	it('shows an about text the operator wrote, and their socials with the About stamp', async () => {
		const { sqlite, platform } = makePassportDb();
		sqlite.exec(`
			INSERT INTO site_settings (key, value) VALUES
				('aboutText', 'A red fox in a blue jacket.'),
				('blueskyUrl', 'https://bsky.app/profile/ashby.example');
		`);

		const data = await loadPassportPage(platform);
		expect(data.passport.about).toBe('A red fox in a blue jacket.');
		expect(data.passport.socials).toEqual([{ platform: 'bluesky', url: 'https://bsky.app/profile/ashby.example' }]);
		expect(kinds(data)).toEqual(['about']);
	});

	// Sona details live on /art, not /about, so they alone never earn the
	// About stamp: it would open a page with none of them.
	it('gives no About stamp for sona details alone, with no socials and no conventions', async () => {
		const { sqlite, platform } = makePassportDb();
		sqlite.exec(`
			INSERT INTO site_settings (key, value) VALUES
				('sonaBuild', 'Lanky'),
				('sonaKeyFeatures', 'A white tail tip'),
				('sonaColors', '[{"name":"Rust","hex":"#b7410e"}]'),
				('sonaDos', 'Blue jacket'),
				('sonaDonts', 'No hat');
		`);

		const data = await loadPassportPage(platform);
		expect(kinds(data)).not.toContain('about');
	});

	it('degrades to no feature stamps and the avatar when the batch never answers', async () => {
		const { db, sqlite } = makePassportDb();
		await db.insert(artists).values({ id: 1, name: 'A' });
		await db.insert(images).values({ id: 1, title: 'One', slug: 'one', imageUrl: '/1.png', artistId: 1 });
		sqlite.exec("INSERT INTO sticker_packs (published) VALUES (1); INSERT INTO stickers (pack_id) VALUES (1);");
		// A stall, not a failure: the batch promise never settles, so only the
		// timeout can end the wait.
		const stalled = Object.assign(Object.create(db), { batch: () => new Promise(() => {}) }) as typeof db;

		const passport = await loadPassport({
			db: stalled,
			env: undefined,
			settings: { ...DEFAULTS, adminAvatarUrl: '/face.png' },
			host: 'example.ink',
			now: new Date(),
			timeoutMs: 20
		});
		expect(passport.stamps.features).toEqual([]);
		expect(passport.picture).toMatchObject({ kind: 'avatar', imageUrl: '/face.png' });
	});

	it('degrades to a stampless passport, not a 500, when every D1 read fails', async () => {
		// Warm the settings cache on a healthy DB so the load reaches the passport
		// branch, then swap in a D1 whose every statement throws.
		const { sqlite, db, platform } = makePassportDb('mock');
		sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('adminAvatarUrl', '/face.png')").run();
		await db.insert(artists).values({ id: 1, name: 'A' });
		await db.insert(images).values({ id: 1, title: 'One', slug: 'one', imageUrl: '/1.png', artistId: 1 });
		await loadPassportPage(platform);

		const failingD1 = {
			prepare: () => {
				throw new Error('D1_ERROR: transient');
			},
			batch: () => Promise.reject(new Error('D1_ERROR: transient'))
		} as unknown as D1Database;
		const failingPlatform = { env: { DB: failingD1, FURTRACK_MODE: 'mock' } } as unknown as App.Platform;

		const data = await loadPassportPage(failingPlatform);
		expect(data.settings.landingLayout).toBe('passport');
		expect(data.passport.hasStamps).toBe(false);
		expect(data.passport.stamps.features).toEqual([]);
		// No count read means no stamp, never a zero, and the page still has a face.
		expect(data.passport.picture).toMatchObject({ kind: 'avatar' });
	});
});
