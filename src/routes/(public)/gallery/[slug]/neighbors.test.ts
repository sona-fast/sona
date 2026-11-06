import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { clearSettingsCache } from '$lib/server/settings';
import { clearStickerTabCache } from '$lib/server/stickers';
import { clearVrTabCache } from '$lib/server/vr-gate';
import { clearFursuitPhotosCache } from '$lib/server/fursuit-import';
import { load as gridLoad } from '../+page.server';
import { load as detailLoad } from './+page.server';
import { load as collectionLoad } from '../../collections/[slug]/+page.server';
import { collectionContextQuery, galleryContextQuery, type GalleryFilters } from '$lib/gallery';

// The real neighbor walks, unless a test sets `stall.on` to make them hang
// the way a slow D1 read does, so the detail page's timeout path runs.
const stall = vi.hoisted(() => ({ on: false }));
vi.mock('$lib/server/gallery-order', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/gallery-order')>();
	const stallable =
		<A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
		(...args: A): Promise<R> =>
			stall.on ? new Promise<R>(() => {}) : fn(...args);
	return {
		...actual,
		galleryNeighbors: stallable(actual.galleryNeighbors),
		collectionNeighbors: stallable(actual.collectionNeighbors)
	};
});

// SONA-179: the detail page's previous/next must walk the same order the grid
// shows, under the same filters and sort, across the grid's page breaks. The
// strongest check is to walk both: read the grid page by page, then follow the
// detail page's `next` links from the first card and its `prev` links from the
// last, and require all three sequences to match. Ties in the sort key are
// seeded on purpose; without a total order the walk and the grid drift.

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
			global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
			aliases TEXT, avatar_resolved_at TEXT, ledger_private INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE collections (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL,
			cover_image_url TEXT, created_at TEXT NOT NULL
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
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT);
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
		CREATE TABLE characters (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
			is_owner INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE image_characters (image_id INTEGER NOT NULL, character_id INTEGER NOT NULL);
		CREATE TABLE fursuit_photos (id INTEGER PRIMARY KEY AUTOINCREMENT);
		CREATE TABLE vr_avatars (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1, manager_artist_id INTEGER);
		CREATE TABLE stickers (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER, pack_id INTEGER);
		CREATE TABLE avatar_credits (avatar_id INTEGER NOT NULL, artist_id INTEGER NOT NULL);
		CREATE TABLE commissions (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER NOT NULL);
	`);
	return { sqlite, platform: { env: { DB: makeD1(sqlite) } } as unknown as App.Platform };
}

/**
 * 27 grid pieces (more than one 20-card grid page) by two artists. Upload
 * dates repeat in threes so every sort has ties for the id to settle; every
 * third piece has no commission date, so the commissioned sorts fall back to
 * the upload date for it. Plus one variant and one draft that must never be a
 * neighbor.
 */
function seed(sqlite: { exec: (sql: string) => void }) {
	sqlite.exec(`
		INSERT INTO artists (id, name) VALUES (1, 'Kestrel'), (2, 'Wren');
		INSERT INTO tags (id, name) VALUES (1, 'ych');
		INSERT INTO characters (id, name) VALUES (1, 'Ember');
	`);
	const rows: string[] = [];
	for (let i = 1; i <= 27; i++) {
		const created = `2026-0${1 + Math.floor((i - 1) / 9)}-1${Math.floor(((i - 1) % 9) / 3)}T00:00:00.000Z`;
		const commissioned = i % 3 === 0 ? 'NULL' : `'2025-${String(1 + (i % 7)).padStart(2, '0')}-01'`;
		const title = i % 4 === 0 ? `Fox ${i}` : `Piece ${i}`;
		rows.push(`(${i}, '${title}', 'p${i}', '/img/p${i}.png', ${1 + (i % 2)}, ${commissioned}, '${created}')`);
	}
	sqlite.exec(`
		INSERT INTO images (id, title, slug, image_url, artist_id, commissioned_at, created_at) VALUES ${rows.join(', ')};
		INSERT INTO images (id, title, slug, image_url, artist_id, parent_image_id, created_at)
			VALUES (100, 'Variant of 5', 'p5-alt', '/img/p5-alt.png', 2, 5, '2027-01-01T00:00:00.000Z');
		INSERT INTO images (id, title, slug, image_url, artist_id, published, created_at)
			VALUES (101, 'Draft', 'draft', '/img/draft.png', 1, 0, '2026-02-12T00:00:00.000Z');
		INSERT INTO image_tags (image_id, tag_id) SELECT id, 1 FROM images WHERE id % 2 = 1;
		INSERT INTO image_characters (image_id, character_id) SELECT id, 1 FROM images WHERE id % 5 <> 0;
	`);
}

type Neighbor = { slug: string } | null;
type DetailData = { neighbors: { prev: Neighbor; next: Neighbor }; contextQuery: string };

async function grid(platform: App.Platform, query: string): Promise<string[]> {
	const slugs: string[] = [];
	for (let page = 1; ; page++) {
		clearStickerTabCache();
		clearVrTabCache();
		clearFursuitPhotosCache();
		const sep = query ? '&' : '?';
		const url = new URL(`http://localhost/gallery${query}${sep}page=${page}`);
		const data = (await gridLoad({ platform, url } as never)) as { images: { slug: string }[]; totalPages: number };
		slugs.push(...data.images.map((i) => i.slug));
		if (page >= data.totalPages) return slugs;
	}
}

async function detail(platform: App.Platform, slug: string, query: string): Promise<DetailData> {
	const url = new URL(`http://localhost/gallery/${slug}${query}`);
	return (await detailLoad({ platform, params: { slug }, url } as never)) as DetailData;
}

async function walk(platform: App.Platform, start: string, query: string, dir: 'next' | 'prev') {
	const seen = [start];
	for (let slug = start; ; ) {
		const n = (await detail(platform, slug, query)).neighbors[dir];
		if (!n) return seen;
		if (seen.includes(n.slug)) throw new Error(`cycle at ${n.slug}`);
		seen.push(n.slug);
		slug = n.slug;
	}
}

let db: ReturnType<typeof makeDb>;
beforeEach(() => {
	clearSettingsCache();
	db = makeDb();
	seed(db.sqlite);
});

describe('detail previous/next follows the grid it came from', () => {
	const contexts = [
		'',
		'?sort=oldest',
		'?sort=commissioned-newest',
		'?sort=commissioned-oldest',
		'?tag=ych',
		'?artist=Wren&sort=oldest',
		'?character=Ember&sort=commissioned-newest',
		'?q=Fox',
		'?tag=ych&character=Ember&sort=commissioned-oldest'
	];

	for (const query of contexts) {
		it(`walks the same order as the grid for "${query || '(no context)'}"`, async () => {
			const order = await grid(db.platform, query);
			expect(order.length).toBeGreaterThan(1);
			expect(order).not.toContain('p5-alt');
			expect(order).not.toContain('draft');

			expect(await walk(db.platform, order[0], query, 'next')).toEqual(order);
			expect(await walk(db.platform, order[order.length - 1], query, 'prev')).toEqual([...order].reverse());
		});
	}

	it('crosses the grid page break (card 20 -> card 21)', async () => {
		const order = await grid(db.platform, '');
		expect(order.length).toBeGreaterThan(20);
		const d = await detail(db.platform, order[19], '');
		expect(d.neighbors.next?.slug).toBe(order[20]);
	});

	it('has no previous at the first card and no next at the last', async () => {
		const order = await grid(db.platform, '?sort=oldest');
		expect((await detail(db.platform, order[0], '?sort=oldest')).neighbors.prev).toBeNull();
		expect((await detail(db.platform, order[order.length - 1], '?sort=oldest')).neighbors.next).toBeNull();
	});

	it("pages a variant from its parent's place in the grid", async () => {
		const parent = await detail(db.platform, 'p5', '?tag=ych');
		const variant = await detail(db.platform, 'p5-alt', '?tag=ych');
		expect(variant.neighbors).toEqual(parent.neighbors);
		expect(variant.neighbors.next).not.toBeNull();
	});

	it("uses the site's default sort when the link carries none, like the grid", async () => {
		db.sqlite.exec(`INSERT INTO site_settings (key, value) VALUES ('galleryDefaultSort', 'commissioned-oldest')`);
		clearSettingsCache();
		const order = await grid(db.platform, '');
		expect(order).toEqual(await grid(db.platform, '?sort=commissioned-oldest'));
		expect(await walk(db.platform, order[0], '', 'next')).toEqual(order);
	});

	it('ignores an unknown sort the same way the grid does', async () => {
		const order = await grid(db.platform, '?sort=bogus');
		expect(await walk(db.platform, order[0], '?sort=bogus', 'next')).toEqual(order);
	});

	it("links a grid filtered by an artist's former name with the current name, so the detail page can page it", async () => {
		db.sqlite.exec(`UPDATE artists SET aliases = '[{"displayName":"OldWren","socials":{}}]' WHERE id = 2`);
		clearStickerTabCache();
		clearVrTabCache();
		clearFursuitPhotosCache();
		const url = new URL('http://localhost/gallery?artist=OldWren&sort=oldest');
		const data = (await gridLoad({ platform: db.platform, url } as never)) as { filters: GalleryFilters };
		expect(data.filters.artist).toBe('Wren');

		// The card links the grid page builds from data.filters.
		const query = galleryContextQuery(data.filters, 'oldest');
		expect(query).toBe('?artist=Wren&sort=oldest');
		const order = await grid(db.platform, '?artist=OldWren&sort=oldest');
		expect(order).toEqual(await grid(db.platform, query));
		expect(await walk(db.platform, order[0], query, 'next')).toEqual(order);
		// The detail page matches the artist exactly, so a former name there would page to nothing.
		expect((await detail(db.platform, order[0], '?artist=OldWren&sort=oldest')).neighbors.next).toBeNull();
	});

	it('hands the context on to the next links, minus anything that is not grid context', async () => {
		const d = await detail(db.platform, 'p1', '?tag=ych&sort=oldest&utm_source=x');
		expect(d.contextQuery).toBe('?tag=ych&sort=oldest');
		expect((await detail(db.platform, 'p1', '')).contextQuery).toBe('');
	});
});

// A piece opened from /collections/[slug] pages through that collection, in
// the order the collection page shows, and nowhere else. Anything that isn't
// a real collection holding the piece falls back to the unfiltered gallery.
describe('detail previous/next follows the collection it came from', () => {
	/**
	 * Collection 1 ('badges') holds every odd piece from 1 to 25, which repeats
	 * upload dates in threes, so the id has ties to settle; piece 7 is NSFW
	 * (listed and blurred, so it pages too). Also in it: piece 5's variant,
	 * which never gets a card, and a draft. Piece 2 sits in collection 2.
	 */
	function seedCollections() {
		db.sqlite.exec(`
			INSERT INTO collections (id, name, slug, created_at) VALUES
				(1, 'Badges', 'badges', '2026-01-01'), (2, 'Other', 'other', '2026-01-01');
			UPDATE images SET collection_id = 1 WHERE id % 2 = 1 AND id <= 25;
			UPDATE images SET collection_id = 1 WHERE id IN (100, 101);
			UPDATE images SET collection_id = 2 WHERE id = 2;
			UPDATE images SET nsfw = 1 WHERE id = 7;
		`);
	}

	async function collectionGrid(slug: string): Promise<string[]> {
		const data = (await collectionLoad({ platform: db.platform, params: { slug } } as never)) as {
			images: { slug: string }[];
		};
		return data.images.map((i) => i.slug);
	}

	const inBadges = collectionContextQuery('badges');

	it('walks the same order as the collection page, both ways, and stops at its ends', async () => {
		seedCollections();
		const order = await collectionGrid('badges');
		expect(order).toHaveLength(13);
		expect(order).not.toContain('p5-alt');
		expect(order).not.toContain('draft');
		expect(order).toContain('p7');

		expect(await walk(db.platform, order[0], inBadges, 'next')).toEqual(order);
		expect(await walk(db.platform, order[order.length - 1], inBadges, 'prev')).toEqual([...order].reverse());
		expect((await detail(db.platform, order[0], inBadges)).neighbors.prev).toBeNull();
		expect((await detail(db.platform, order[order.length - 1], inBadges)).neighbors.next).toBeNull();
	});

	it('is not the gallery order', async () => {
		seedCollections();
		const order = await collectionGrid('badges');
		const gallery = await grid(db.platform, '');
		const first = await detail(db.platform, order[0], inBadges);
		const inGallery = await detail(db.platform, order[0], '');
		expect(first.neighbors.next?.slug).toBe(order[1]);
		expect(inGallery.neighbors.next?.slug).toBe(gallery[gallery.indexOf(order[0]) + 1]);
		expect(first.neighbors.next?.slug).not.toBe(inGallery.neighbors.next?.slug);
	});

	it('keeps the collection on the next links', async () => {
		seedCollections();
		expect((await detail(db.platform, 'p1', inBadges)).contextQuery).toBe('?collection=badges');
	});

	it("pages a variant from its parent's place in the collection", async () => {
		seedCollections();
		const parent = await detail(db.platform, 'p5', inBadges);
		const variant = await detail(db.platform, 'p5-alt', inBadges);
		expect(variant.neighbors).toEqual(parent.neighbors);
		expect(variant.contextQuery).toBe('?collection=badges');
	});

	// Membership is the published parent's, not the variant's own column.
	for (const [label, value] of [
		['another collection', '2'],
		['no collection', 'NULL']
	] as const) {
		it(`pages a variant through its parent's collection even when the variant itself is in ${label}`, async () => {
			seedCollections();
			db.sqlite.exec(`UPDATE images SET collection_id = ${value} WHERE id = 100`);
			const parent = await detail(db.platform, 'p5', inBadges);
			const variant = await detail(db.platform, 'p5-alt', inBadges);
			expect(parent.contextQuery).toBe('?collection=badges');
			expect(parent.neighbors.prev).not.toBeNull();
			expect(parent.neighbors.next).not.toBeNull();
			expect(variant.neighbors).toEqual(parent.neighbors);
			expect(variant.contextQuery).toBe('?collection=badges');
		});

		it(`falls back for a variant in the collection whose parent is in ${label}`, async () => {
			seedCollections();
			db.sqlite.exec(`UPDATE images SET collection_id = ${value} WHERE id = 5`);
			const d = await detail(db.platform, 'p5-alt', inBadges);
			const inGallery = await detail(db.platform, 'p5-alt', '');
			expect(inGallery.neighbors.next).not.toBeNull();
			expect(d.neighbors).toEqual(inGallery.neighbors);
			expect(d.contextQuery).toBe('');
		});
	}

	const fallbacks: [string, string, string][] = [
		['an unknown collection', 'p1', collectionContextQuery('nope')],
		['a collection the piece is not in', 'p2', inBadges],
		['another collection than the piece is in', 'p1', collectionContextQuery('other')],
		['a piece in no collection', 'p26', inBadges],
		['a forged slug', 'p1', '?collection=../badges'],
		['a collection with gallery filters forged beside it', 'p2', '?collection=badges&tag=ych&sort=oldest']
	];
	for (const [name, slug, query] of fallbacks) {
		it(`falls back to the unfiltered gallery for ${name}, and drops the context`, async () => {
			seedCollections();
			const d = await detail(db.platform, slug, query);
			expect(d.neighbors).toEqual((await detail(db.platform, slug, '')).neighbors);
			expect(d.contextQuery).toBe('');
		});
	}

	it('falls back for a variant whose parent is unpublished, even if the variant names the collection', async () => {
		seedCollections();
		db.sqlite.exec(`UPDATE images SET published = 0 WHERE id = 5`);
		const d = await detail(db.platform, 'p5-alt', inBadges);
		expect(d.neighbors).toEqual((await detail(db.platform, 'p5-alt', '')).neighbors);
		expect(d.contextQuery).toBe('');
	});

	it('treats a draft as no member, so the draft never becomes reachable by its context', async () => {
		seedCollections();
		const order = await collectionGrid('badges');
		for (const slug of order) {
			const d = await detail(db.platform, slug, inBadges);
			expect(d.neighbors.prev?.slug).not.toBe('draft');
			expect(d.neighbors.next?.slug).not.toBe('draft');
		}
	});
});

// The pager gives up after a couple of seconds so a slow D1 can't hold the
// page. The links it leaves keep a confirmed collection and must not carry
// one the piece isn't in.
describe('detail previous/next when the neighbor read times out', () => {
	beforeEach(() => {
		db.sqlite.exec(`
			INSERT INTO collections (id, name, slug, created_at) VALUES (1, 'Badges', 'badges', '2026-01-01');
			UPDATE images SET collection_id = 1 WHERE id % 2 = 1;
		`);
	});
	afterEach(() => {
		stall.on = false;
		vi.useRealTimers();
	});

	async function timedOut(slug: string, query: string): Promise<DetailData> {
		vi.useFakeTimers();
		stall.on = true;
		const pending = detail(db.platform, slug, query);
		await vi.advanceTimersByTimeAsync(2000);
		return pending;
	}

	it('renders without a pager and keeps the collection the piece is in', async () => {
		const d = await timedOut('p1', collectionContextQuery('badges'));
		expect(d.neighbors).toEqual({ prev: null, next: null });
		expect(d.contextQuery).toBe('?collection=badges');
	});

	it('drops a collection context the piece is not in', async () => {
		const d = await timedOut('p2', collectionContextQuery('badges'));
		expect(d.neighbors).toEqual({ prev: null, next: null });
		expect(d.contextQuery).toBe('');
	});

	it('keeps a gallery context, which needs no confirming', async () => {
		const d = await timedOut('p1', '?tag=ych');
		expect(d.neighbors).toEqual({ prev: null, next: null });
		expect(d.contextQuery).toBe('?tag=ych');
	});
});
