import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { clearStickerTabCache } from '$lib/server/stickers';
import { makeD1 } from '$lib/server/test/d1';

import { load } from './+page.server';

const NOW = '2026-01-01T00:00:00.000Z';

// Only the tables the /vr index load reads, columns limited to what its
// queries reference (same shape as gallery/page.server.test.ts).
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE vr_avatars (
			id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, name TEXT NOT NULL,
			character_id INTEGER NOT NULL, model_url TEXT, model_format TEXT,
			model_size_bytes INTEGER, poster_image_id INTEGER, external_url TEXT,
			license TEXT, permission_source TEXT, downloadable INTEGER NOT NULL DEFAULT 0,
			nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
			description TEXT, created_at TEXT NOT NULL
		);
		CREATE TABLE avatar_platforms (avatar_id INTEGER NOT NULL, platform TEXT NOT NULL);
		CREATE TABLE avatar_media (
			avatar_id INTEGER NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
			width INTEGER, height INTEGER, position INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, image_url TEXT NOT NULL, thumbnail_url TEXT,
			nsfw INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE fursuit_photos (id INTEGER PRIMARY KEY AUTOINCREMENT);
		CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
	`);
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function addAvatar(
	sqlite: ReturnType<typeof makeDb>['sqlite'],
	opts: {
		slug: string;
		published?: number;
		modelUrl?: string | null;
		externalUrl?: string | null;
		posterImageId?: number | null;
		nsfw?: number;
		createdAt?: string;
	}
) {
	return sqlite
		.prepare(
			`INSERT INTO vr_avatars (slug, name, character_id, model_url, model_format, external_url, poster_image_id, nsfw, published, created_at)
			 VALUES (?, ?, 1, ?, 'vrm', ?, ?, ?, ?, ?)`
		)
		.run(
			opts.slug,
			opts.slug,
			opts.modelUrl ?? null,
			opts.externalUrl ?? null,
			opts.posterImageId ?? null,
			opts.nsfw ?? 0,
			opts.published ?? 1,
			opts.createdAt ?? NOW
		).lastInsertRowid as number;
}

function addMedia(
	sqlite: ReturnType<typeof makeDb>['sqlite'],
	avatarId: number,
	kind: 'image' | 'video',
	url: string,
	position: number
) {
	sqlite
		.prepare('INSERT INTO avatar_media (avatar_id, kind, url, position) VALUES (?, ?, ?, ?)')
		.run(avatarId, kind, url, position);
}

type IndexData = {
	avatars: Array<{
		slug: string;
		nsfw: boolean;
		posterUrl: string | null;
		platforms: string[];
		hasModel: boolean;
		formatLabel: string | null;
		externalName: string | null;
	}>;
	total: number;
	ogImage: string | null;
	stickersEnabled: boolean;
};

async function loadData(platform: App.Platform): Promise<IndexData> {
	// The stickers probe caches per-isolate; clear it so each load sees the
	// current DB (the pill matrix below re-queries after seeding).
	clearStickerTabCache();
	return (await load({ platform } as never)) as IndexData;
}

describe('/vr index load', () => {
	it('lists published avatars only', async () => {
		const { sqlite, platform } = makeDb();
		addAvatar(sqlite, { slug: 'live' });
		addAvatar(sqlite, { slug: 'draft', published: 0 });

		const data = await loadData(platform);
		expect(data.avatars.map((a) => a.slug)).toEqual(['live']);
		expect(data.total).toBe(1);
	});

	it('gates the Stickers pill on a published pack existing (shared probe)', async () => {
		const { sqlite, platform } = makeDb();
		addAvatar(sqlite, { slug: 'live' });
		// zero packs, then a draft -> hidden; a published pack -> shown
		expect((await loadData(platform)).stickersEnabled).toBe(false);
		sqlite.prepare('INSERT INTO sticker_packs (published) VALUES (0)').run();
		expect((await loadData(platform)).stickersEnabled).toBe(false);
		sqlite.prepare('INSERT INTO sticker_packs (published) VALUES (1)').run();
		expect((await loadData(platform)).stickersEnabled).toBe(true);
	});

	it('fails OPEN (pill shown) when the stickers probe hits a D1 failure', async () => {
		// Same posture as the (paths) layout's D1-error case: the probe is
		// wrapped fail-open AT CREATION, so a rejecting stickers read can neither
		// hide the pill, crash the load, nor float as an unhandled rejection
		// while the fursuit COUNT is in flight.
		const { sqlite, platform } = makeDb();
		sqlite.exec('DROP TABLE sticker_packs'); // the probe's read now rejects
		addAvatar(sqlite, { slug: 'live' });

		const data = await loadData(platform);
		expect(data.stickersEnabled).toBe(true);
		// The rest of the page still loads normally.
		expect(data.avatars.map((a) => a.slug)).toEqual(['live']);
	});

	it('joins the poster image and groups platform badges per avatar', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO images (id, image_url, thumbnail_url) VALUES (1, ?, ?)')
			.run('https://cdn.example.com/poster.png', 'https://cdn.example.com/poster-thumb.png');
		const id = addAvatar(sqlite, { slug: 'foxo', posterImageId: 1 });
		sqlite.prepare('INSERT INTO avatar_platforms (avatar_id, platform) VALUES (?, ?)').run(id, 'vrchat');
		sqlite.prepare('INSERT INTO avatar_platforms (avatar_id, platform) VALUES (?, ?)').run(id, 'resonite');

		const data = await loadData(platform);
		expect(data.avatars[0].posterUrl).toBe('https://cdn.example.com/poster-thumb.png');
		expect(data.avatars[0].platforms).toEqual(['vrchat', 'resonite']);
	});

	it('inherits NSFW from the poster image, not just the avatar flag', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO images (id, image_url, nsfw) VALUES (1, ?, 1)')
			.run('https://cdn.example.com/mature-poster.png');
		addAvatar(sqlite, { slug: 'mature-poster-only', posterImageId: 1 });
		addAvatar(sqlite, { slug: 'flagged-avatar', nsfw: 1 });
		addAvatar(sqlite, { slug: 'clean' });

		const data = await loadData(platform);
		const bySlug = Object.fromEntries(data.avatars.map((a) => [a.slug, a]));
		expect(bySlug['mature-poster-only'].nsfw).toBe(true);
		expect(bySlug['flagged-avatar'].nsfw).toBe(true);
		expect(bySlug.clean.nsfw).toBe(false);
		// The join column is server-side input only — the payload ships the merged
		// flag, never the raw posterNsfw (same pin as the detail loader's test).
		expect(JSON.stringify(data)).not.toContain('posterNsfw');
	});

	it('flags a hosted model with its format label, and external-only entries with their destination', async () => {
		const { sqlite, platform } = makeDb();
		addAvatar(sqlite, { slug: 'hosted', modelUrl: 'https://cdn.example.com/models/a.vrm' });
		addAvatar(sqlite, { slug: 'external', externalUrl: 'https://hub.vroid.com/characters/1' });
		addAvatar(sqlite, {
			slug: 'both',
			modelUrl: 'https://cdn.example.com/models/b.vrm',
			externalUrl: 'https://hub.vroid.com/characters/2'
		});

		const data = await loadData(platform);
		const bySlug = Object.fromEntries(data.avatars.map((a) => [a.slug, a]));
		expect(bySlug.hosted.hasModel).toBe(true);
		expect(bySlug.hosted.formatLabel).toBe('VRM');
		expect(bySlug.hosted.externalName).toBeNull();
		expect(bySlug.external.hasModel).toBe(false);
		expect(bySlug.external.externalName).toBe('VRoid Hub');
		// A hosted model wins the badge; the external home shows on the detail page.
		expect(bySlug.both.hasModel).toBe(true);
		expect(bySlug.both.externalName).toBeNull();
	});

	it('uses a showcase image for a posterless avatar, and keeps a real poster', async () => {
		// Ordering and video-skipping are covered in vr-showcase.test.ts; this
		// pins the loader's wiring only.
		const { sqlite, platform } = makeDb();
		const bare = addAvatar(sqlite, { slug: 'bare' });
		addMedia(sqlite, bare, 'image', 'https://cdn.example.com/shot.png', 0);
		sqlite
			.prepare('INSERT INTO images (id, image_url, thumbnail_url) VALUES (1, ?, ?)')
			.run('https://cdn.example.com/poster.png', 'https://cdn.example.com/poster-thumb.png');
		const postered = addAvatar(sqlite, { slug: 'postered', posterImageId: 1 });
		addMedia(sqlite, postered, 'image', 'https://cdn.example.com/ignored.png', 0);

		const data = await loadData(platform);
		const bySlug = Object.fromEntries(data.avatars.map((a) => [a.slug, a]));
		expect(bySlug.bare.posterUrl).toBe('https://cdn.example.com/shot.png');
		expect(bySlug.postered.posterUrl).toBe('https://cdn.example.com/poster-thumb.png');
	});

	it('takes the link preview from the newest SFW avatar, skipping a newer NSFW one', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO images (id, image_url, thumbnail_url) VALUES (1, ?, ?)')
			.run('https://cdn.example.com/sfw.png', 'https://cdn.example.com/sfw-thumb.png');
		sqlite
			.prepare('INSERT INTO images (id, image_url, thumbnail_url) VALUES (2, ?, ?)')
			.run('https://cdn.example.com/mature.png', 'https://cdn.example.com/mature-thumb.png');
		addAvatar(sqlite, { slug: 'older-sfw', posterImageId: 1, createdAt: '2026-01-01T00:00:00.000Z' });
		addAvatar(sqlite, { slug: 'newest-nsfw', posterImageId: 2, nsfw: 1, createdAt: '2026-02-01T00:00:00.000Z' });

		const data = await loadData(platform);
		// The NSFW avatar leads the list, so a "first avatar" preview would leak it.
		expect(data.avatars[0].slug).toBe('newest-nsfw');
		expect(data.ogImage).toBe('https://cdn.example.com/sfw-thumb.png');
	});

	it('takes the link preview from an older SFW avatar when the newest SFW one has no image', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO images (id, image_url, thumbnail_url) VALUES (1, ?, ?)')
			.run('https://cdn.example.com/older.png', 'https://cdn.example.com/older-thumb.png');
		addAvatar(sqlite, { slug: 'older-sfw', posterImageId: 1, createdAt: '2026-01-01T00:00:00.000Z' });
		const newest = addAvatar(sqlite, { slug: 'newest-video', createdAt: '2026-02-01T00:00:00.000Z' });
		addMedia(sqlite, newest, 'video', 'https://cdn.example.com/clip.mp4', 0);

		const data = await loadData(platform);
		expect(data.avatars[0].slug).toBe('newest-video');
		expect(data.avatars[0].posterUrl).toBeNull();
		expect(data.ogImage).toBe('https://cdn.example.com/older-thumb.png');
	});

	it('has no link preview when every avatar is NSFW', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO images (id, image_url, thumbnail_url) VALUES (1, ?, ?)')
			.run('https://cdn.example.com/mature.png', 'https://cdn.example.com/mature-thumb.png');
		addAvatar(sqlite, { slug: 'a', posterImageId: 1, nsfw: 1, createdAt: '2026-01-01T00:00:00.000Z' });
		const b = addAvatar(sqlite, { slug: 'b', nsfw: 1, createdAt: '2026-02-01T00:00:00.000Z' });
		addMedia(sqlite, b, 'image', 'https://cdn.example.com/b.png', 0);

		const data = await loadData(platform);
		expect(data.ogImage).toBeNull();
	});

	it('keeps a fallback-image avatar out of the blur unless the avatar itself is NSFW', async () => {
		// Showcase media carries no NSFW flag of its own, so the avatar's flag is
		// the only gate — and it must still apply to the stand-in image.
		const { sqlite, platform } = makeDb();
		const clean = addAvatar(sqlite, { slug: 'clean' });
		addMedia(sqlite, clean, 'image', 'https://cdn.example.com/a.png', 0);
		const mature = addAvatar(sqlite, { slug: 'mature', nsfw: 1 });
		addMedia(sqlite, mature, 'image', 'https://cdn.example.com/b.png', 0);

		const data = await loadData(platform);
		const bySlug = Object.fromEntries(data.avatars.map((a) => [a.slug, a]));
		expect(bySlug.clean.nsfw).toBe(false);
		expect(bySlug.mature.nsfw).toBe(true);
		expect(bySlug.mature.posterUrl).toBe('https://cdn.example.com/b.png');
	});
});
