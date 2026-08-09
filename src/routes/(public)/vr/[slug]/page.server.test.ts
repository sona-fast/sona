import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { clearSettingsCache } from '$lib/server/settings';

import { load } from './+page.server';

const ORIGIN = 'https://site.example';
const NOW = '2026-01-01T00:00:00.000Z';

// Only the tables the detail load reads, columns limited to what its queries
// reference (same shape as gallery/page.server.test.ts).
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE vr_avatars (
			id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, name TEXT NOT NULL,
			character_id INTEGER NOT NULL, model_url TEXT, model_format TEXT,
			model_size_bytes INTEGER, poster_image_id INTEGER, external_url TEXT,
			license TEXT, permission_source TEXT, downloadable INTEGER NOT NULL DEFAULT 0,
			nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
			description TEXT, created_at TEXT NOT NULL
		);
		CREATE TABLE avatar_credits (
			avatar_id INTEGER NOT NULL, artist_id INTEGER NOT NULL, role TEXT NOT NULL,
			role_label TEXT, position INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE avatar_media (
			avatar_id INTEGER NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
			width INTEGER, height INTEGER, position INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE avatar_platforms (avatar_id INTEGER NOT NULL, platform TEXT NOT NULL);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT
		);
		CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, image_url TEXT NOT NULL, width INTEGER, height INTEGER
		);
	`);
	sqlite.prepare('INSERT INTO characters (id, name) VALUES (1, ?)').run('Foxo');
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function addAvatar(
	sqlite: ReturnType<typeof makeDb>['sqlite'],
	opts: {
		slug?: string;
		published?: number;
		modelUrl?: string | null;
		license?: string | null;
		downloadable?: number;
	} = {}
) {
	return sqlite
		.prepare(
			`INSERT INTO vr_avatars (slug, name, character_id, model_url, model_format, license, downloadable, published, created_at)
			 VALUES (?, ?, 1, ?, 'vrm', ?, ?, ?, ?)`
		)
		.run(
			opts.slug ?? 'foxo',
			'Foxo VR',
			opts.modelUrl ?? null,
			opts.license ?? null,
			opts.downloadable ?? 0,
			opts.published ?? 1,
			NOW
		).lastInsertRowid as number;
}

function setR2PublicUrl(sqlite: ReturnType<typeof makeDb>['sqlite'], url: string) {
	sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run('r2PublicUrl', url);
}

function loadEvent(platform: App.Platform, slug = 'foxo') {
	return { platform, params: { slug }, url: new URL(`${ORIGIN}/vr/${slug}`) } as never;
}

type DetailData = {
	avatar: { name: string; characterName: string };
	modelPath: string | null;
	downloadAllowed: boolean;
	credits: Array<{ artistName: string; role: string; roleLabel: string | null }>;
	media: Array<{ kind: string; url: string }>;
	platforms: string[];
};

async function loadData(platform: App.Platform, slug = 'foxo'): Promise<DetailData> {
	return (await load(loadEvent(platform, slug))) as DetailData;
}

async function status(promise: Promise<unknown>): Promise<number> {
	try {
		await promise;
		return 200;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

// getSettings caches per isolate; each test seeds its own r2PublicUrl.
beforeEach(() => clearSettingsCache());

describe('/vr/[slug] load — visibility', () => {
	it('404s an unknown slug', async () => {
		const { platform } = makeDb();
		await expect(status(loadData(platform, 'nope'))).resolves.toBe(404);
	});

	it('404s an unpublished avatar', async () => {
		const { sqlite, platform } = makeDb();
		addAvatar(sqlite, { published: 0 });
		await expect(status(loadData(platform))).resolves.toBe(404);
	});

	it('loads a published avatar with its character name', async () => {
		const { sqlite, platform } = makeDb();
		addAvatar(sqlite);
		const data = await loadData(platform);
		expect(data.avatar.name).toBe('Foxo VR');
		expect(data.avatar.characterName).toBe('Foxo');
	});
});

describe('/vr/[slug] load — modelPath derivation', () => {
	it('maps a custom-domain model URL to the same-origin /img path', async () => {
		const { sqlite, platform } = makeDb();
		setR2PublicUrl(sqlite, 'https://cdn.example.com');
		addAvatar(sqlite, { modelUrl: 'https://cdn.example.com/models/foxo.vrm' });
		const data = await loadData(platform);
		expect(data.modelPath).toBe('/img/models/foxo.vrm');
	});

	it('keeps an /img-relative stored URL as-is', async () => {
		const { sqlite, platform } = makeDb();
		addAvatar(sqlite, { modelUrl: '/img/models/foxo.vrm' });
		const data = await loadData(platform);
		expect(data.modelPath).toBe('/img/models/foxo.vrm');
	});

	it('yields no viewer path for a foreign-host model URL', async () => {
		const { sqlite, platform } = makeDb();
		setR2PublicUrl(sqlite, 'https://cdn.example.com');
		addAvatar(sqlite, { modelUrl: 'https://elsewhere.example/models/foxo.vrm' });
		const data = await loadData(platform);
		expect(data.modelPath).toBeNull();
	});

	it('yields no viewer path when there is no self-hosted model', async () => {
		const { sqlite, platform } = makeDb();
		addAvatar(sqlite, { modelUrl: null });
		const data = await loadData(platform);
		expect(data.modelPath).toBeNull();
	});
});

describe('/vr/[slug] load — downloadAllowed mirrors the endpoint', () => {
	it('allows only permissive license + downloadable + reachable model', async () => {
		const { sqlite, platform } = makeDb();
		addAvatar(sqlite, { modelUrl: '/img/models/foxo.vrm', license: 'cc-by', downloadable: 1 });
		const data = await loadData(platform);
		expect(data.downloadAllowed).toBe(true);
	});

	it('refuses a restrictive license even with downloadable=true', async () => {
		const { sqlite, platform } = makeDb();
		addAvatar(sqlite, {
			modelUrl: '/img/models/foxo.vrm',
			license: 'all-rights-reserved',
			downloadable: 1
		});
		const data = await loadData(platform);
		expect(data.downloadAllowed).toBe(false);
	});

	it('refuses when downloadable is off', async () => {
		const { sqlite, platform } = makeDb();
		addAvatar(sqlite, { modelUrl: '/img/models/foxo.vrm', license: 'cc-by', downloadable: 0 });
		const data = await loadData(platform);
		expect(data.downloadAllowed).toBe(false);
	});
});

describe('/vr/[slug] load — credits, media, platforms', () => {
	it('orders credits by position and carries roleLabel for role=other', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite);
		sqlite.prepare('INSERT INTO artists (id, name) VALUES (1, ?), (2, ?), (3, ?)').run('Zeta', 'Alba', 'Miko');
		const ins = sqlite.prepare(
			'INSERT INTO avatar_credits (avatar_id, artist_id, role, role_label, position) VALUES (?, ?, ?, ?, ?)'
		);
		// Inserted out of order on purpose: position must win, not insert order.
		ins.run(id, 3, 'other', 'Physics bones', 2);
		ins.run(id, 1, 'modeler', null, 0);
		ins.run(id, 2, 'texture', null, 1);

		const data = await loadData(platform);
		expect(data.credits.map((c) => c.artistName)).toEqual(['Zeta', 'Alba', 'Miko']);
		expect(data.credits[2]).toMatchObject({ role: 'other', roleLabel: 'Physics bones' });
	});

	it('carries each artist\'s socials for the per-row icons (gallery treatment)', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite);
		sqlite
			.prepare('INSERT INTO artists (id, name, twitter_url, bluesky_url) VALUES (1, ?, ?, ?)')
			.run('Kestrel', 'https://twitter.com/kestrelworks', 'https://bsky.app/profile/kestrelworks');
		sqlite
			.prepare('INSERT INTO avatar_credits (avatar_id, artist_id, role, role_label, position) VALUES (?, 1, ?, NULL, 0)')
			.run(id, 'base');

		const data = await loadData(platform);
		expect(data.credits[0]).toMatchObject({
			artistTwitter: 'https://twitter.com/kestrelworks',
			artistBluesky: 'https://bsky.app/profile/kestrelworks',
			artistPatreon: null
		});
	});

	it('orders media by position and returns platforms', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite);
		const ins = sqlite.prepare(
			'INSERT INTO avatar_media (avatar_id, kind, url, position) VALUES (?, ?, ?, ?)'
		);
		ins.run(id, 'video', 'https://cdn.example.com/clip.webm', 1);
		ins.run(id, 'image', 'https://cdn.example.com/shot.png', 0);
		sqlite.prepare('INSERT INTO avatar_platforms (avatar_id, platform) VALUES (?, ?)').run(id, 'vrchat');

		const data = await loadData(platform);
		expect(data.media.map((mRow) => mRow.kind)).toEqual(['image', 'video']);
		expect(data.platforms).toEqual(['vrchat']);
	});
});
