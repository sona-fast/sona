import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
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
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, image_url TEXT NOT NULL, thumbnail_url TEXT,
			nsfw INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE fursuit_photos (id INTEGER PRIMARY KEY AUTOINCREMENT);
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
			NOW
		).lastInsertRowid as number;
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
};

async function loadData(platform: App.Platform): Promise<IndexData> {
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
});
