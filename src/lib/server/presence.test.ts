import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';
import { characters, images, imageTags, siteSettings, tags } from './db/schema';
import { makeD1 } from './test/d1';
import { artHasContent, probeArtContent, sonaDetails } from './presence';

// Empty sona-details block: every settings field blank, so artHasContent leans
// entirely on the row arguments — the shape a fresh fork with no details has.
const emptySona = sonaDetails({
	sonaSpecies: '',
	sonaBuild: '',
	sonaKeyFeatures: '',
	sonaColors: '[]',
	sonaDos: '',
	sonaDonts: '',
	pronouns: ''
});

describe('artHasContent (#42 content gate)', () => {
	it('is absent when ref sheet, recent art and details are all empty', () => {
		expect(artHasContent(emptySona, null, [])).toBe(false);
	});

	it('is present when any single source exists', () => {
		expect(artHasContent(emptySona, { slug: 'ref' }, [])).toBe(true);
		expect(artHasContent(emptySona, null, [{ slug: 'r' }])).toBe(true);
	});

	// #58: featured art needs no separate argument. A featured image is
	// published + non-NSFW, so it's always part of recentArt's pool — a
	// "featured but no recent art" state is unreachable, and a non-empty
	// recentArt already gates the page present.
	it('counts featured art via recentArt (featured is a subset of the recent pool)', () => {
		expect(artHasContent(emptySona, null, [{ slug: 'featured-also-recent' }])).toBe(true);
	});

	// SONA-210: pronouns is a detail row like species, so a fork whose ONLY filled
	// field is pronouns has content. Left out of the predicate, /art would 404 on
	// a page that renders a row, and the splash would hide a card that works.
	it('is present when pronouns is the only filled detail', () => {
		const pronounsOnly = sonaDetails({
			sonaSpecies: '',
			sonaBuild: '',
			sonaKeyFeatures: '',
			sonaColors: '[]',
			sonaDos: '',
			sonaDonts: '',
			pronouns: 'they/them'
		});
		expect(artHasContent(pronounsOnly, null, [])).toBe(true);
	});
});

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
			variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0, featured_order INTEGER,
			created_at TEXT NOT NULL DEFAULT ''
		);
	`);
	return drizzle(makeD1(sqlite), { schema });
}

// The probe and the /art load must resolve the ref sheet identically, or the
// splash card links to a page that 404s. SONA-18 added the variant exclusion to
// both — these pin the probe half of that agreement.
describe('probeArtContent — ref-sheet sources (SONA-18)', () => {
	it('is absent when the only designated image is a variant', async () => {
		const db = makeDb();
		await db.insert(images).values([
			{ id: 5, title: 'Parent', slug: 'art-5', imageUrl: '/5.png', artistId: 1, published: false, createdAt: '' },
			{ id: 7, title: 'Variant', slug: 'art-7', imageUrl: '/7.png', artistId: 1, published: true, nsfw: true, parentImageId: 5, createdAt: '' }
		]);
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 7 });

		// The variant is published but NSFW, so it isn't recent art either.
		expect(await probeArtContent(db)).toBe(false);
	});

	it('is absent when the only reference-tagged image is a variant', async () => {
		const db = makeDb();
		await db.insert(tags).values({ id: 1, name: 'reference' });
		await db.insert(images).values([
			{ id: 5, title: 'Parent', slug: 'art-5', imageUrl: '/5.png', artistId: 1, published: false, createdAt: '' },
			{ id: 7, title: 'Variant', slug: 'art-7', imageUrl: '/7.png', artistId: 1, published: true, nsfw: true, parentImageId: 5, createdAt: '' }
		]);
		await db.insert(imageTags).values({ imageId: 7, tagId: 1 });

		expect(await probeArtContent(db)).toBe(false);
	});

	it('is present for an NSFW non-variant ref sheet (the shield keeps it renderable)', async () => {
		const db = makeDb();
		await db.insert(images).values({ id: 5, title: 'Ref', slug: 'art-5', imageUrl: '/5.png', artistId: 1, published: true, nsfw: true, createdAt: '' });
		await db.insert(characters).values({ name: 'Owner', isOwner: true, referenceImageId: 5 });

		expect(await probeArtContent(db)).toBe(true);
	});

	// SONA-210: the probe reads the detail keys itself, so a key added to
	// sonaDetails but not to its inArray list resolves false here while
	// artHasContent says true — the splash would hide a card whose page renders.
	it('is present for a fork whose only content is pronouns', async () => {
		const db = makeDb();
		await db.insert(siteSettings).values({ key: 'pronouns', value: 'they/them' });

		expect(await probeArtContent(db)).toBe(true);
	});
});
