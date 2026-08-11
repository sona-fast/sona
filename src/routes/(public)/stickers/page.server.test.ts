import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { clearVrTabCache } from '$lib/server/vr-gate';

import { load } from './+page.server';

// Only the tables the stickers load touches, columns limited to what its
// queries reference (the pack/sticker tables carry their full column set —
// listPacks selects whole rows).
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE sticker_packs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL,
			description TEXT, cover_image_url TEXT, character_id INTEGER NOT NULL,
			manager_artist_id INTEGER, telegram_url TEXT, source TEXT NOT NULL DEFAULT 'self-hosted',
			published INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE stickers (
			id INTEGER PRIMARY KEY AUTOINCREMENT, pack_id INTEGER NOT NULL, artist_id INTEGER,
			image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER,
			format TEXT NOT NULL DEFAULT 'webp', is_animated INTEGER NOT NULL DEFAULT 0,
			position INTEGER NOT NULL DEFAULT 0, nsfw INTEGER NOT NULL DEFAULT 0,
			telegram_file_unique_id TEXT, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE sticker_emojis (sticker_id INTEGER NOT NULL, emoji TEXT NOT NULL);
		CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, aliases TEXT);
		CREATE TABLE fursuit_photos (id INTEGER PRIMARY KEY AUTOINCREMENT);
		CREATE TABLE vr_avatars (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
	`);
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function loadEvent(platform: App.Platform) {
	return { platform, url: new URL('http://localhost/stickers') } as never;
}

type StickersData = { vrEnabled: boolean };

async function loadData(platform: App.Platform): Promise<StickersData> {
	// The vr probe caches per-isolate; clear it so each load sees the current
	// DB (the matrix below re-queries after seeding).
	clearVrTabCache();
	return (await load(loadEvent(platform))) as StickersData;
}

// The VR Avatars pill must track the gallery's rule exactly (shared
// vrTabEnabled probe) — same 3-case matrix as gallery/page.server.test.ts.
describe('stickers load — VR Avatars tab visibility', () => {
	it('hides the tab with zero avatars', async () => {
		const { platform } = makeDb();
		expect((await loadData(platform)).vrEnabled).toBe(false);
	});

	it('keeps the tab hidden while only drafts exist', async () => {
		const { sqlite, platform } = makeDb();
		sqlite.exec('INSERT INTO vr_avatars (published) VALUES (0)');
		expect((await loadData(platform)).vrEnabled).toBe(false);
	});

	it('shows the tab once a published avatar exists', async () => {
		const { sqlite, platform } = makeDb();
		sqlite.exec('INSERT INTO vr_avatars (published) VALUES (0)');
		sqlite.exec('INSERT INTO vr_avatars (published) VALUES (1)');
		expect((await loadData(platform)).vrEnabled).toBe(true);
	});
});
