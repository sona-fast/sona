import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { isRedirect } from '@sveltejs/kit';
import { makeD1 } from '$lib/server/test/d1';
import { PUBLIC_WORK_TABLES } from '$lib/server/test/public-work-tables';
import { clearSettingsCache } from '$lib/server/settings';

import { actions } from './+page.server';

beforeEach(() => {
	// getSettings caches per isolate and every test builds a fresh DB.
	clearSettingsCache();
});

// A token that UTApi accepts so the default uploadthing storage constructs and
// isOwnedUrl recognises *.ufs.sh/f/ URLs as ours (no network is made).
const utToken = Buffer.from(JSON.stringify({ apiKey: 'sk_test_x', appId: 'testapp', regions: ['sea1'] })).toString('base64');

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE characters (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
			is_owner INTEGER NOT NULL DEFAULT 0, reference_image_id INTEGER, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
			bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT,
			patreon_url TEXT, instagram_url TEXT, global_id TEXT, registry_version INTEGER,
			registry_synced_at TEXT, aliases TEXT, avatar_resolved_at TEXT, ledger_private INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
		);
		CREATE TABLE sticker_packs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT,
			cover_image_url TEXT, character_id INTEGER NOT NULL, manager_artist_id INTEGER, telegram_url TEXT,
			source TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
		);
		CREATE TABLE stickers (
			id INTEGER PRIMARY KEY AUTOINCREMENT, pack_id INTEGER NOT NULL, artist_id INTEGER,
			image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER,
			format TEXT NOT NULL DEFAULT 'webp', is_animated INTEGER NOT NULL DEFAULT 0,
			position INTEGER NOT NULL DEFAULT 0, nsfw INTEGER NOT NULL DEFAULT 0,
			telegram_file_unique_id TEXT, created_at TEXT NOT NULL
		);
		CREATE TABLE sticker_emojis (sticker_id INTEGER NOT NULL, emoji TEXT NOT NULL);
	`);
	sqlite.prepare('INSERT INTO characters (id, name) VALUES (1, ?)').run('Taro');
	sqlite.prepare("INSERT INTO artists (id, name, ledger_private, created_at) VALUES (2, ?, 1, '')").run('Quill');
	sqlite.exec(PUBLIC_WORK_TABLES);
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1, UPLOADTHING_TOKEN: utToken } } as unknown as App.Platform };
}

// The sticker credits the Keep private artist; the pack's default artist is a
// new one, which resolveOrCreateArtist would insert.
function packForm(overrides: Record<string, string> = {}): FormData {
	const form = new FormData();
	form.set('name', 'Quill Pack');
	form.set('defaultArtistId', 'new');
	form.set('newArtistName', 'Fresh');
	form.set('sticker[0][imageUrl]', 'https://testapp.ufs.sh/f/one');
	form.set('sticker[0][artistId]', '2');
	for (const [k, v] of Object.entries(overrides)) form.set(k, v);
	return form;
}

async function save(platform: App.Platform, form: FormData): Promise<unknown> {
	const request = new Request('http://localhost/admin/stickers/manual', { method: 'POST', body: form });
	const url = new URL('http://localhost/admin/stickers/manual');
	// The animation sniff is best effort; an offline fetch records the sticker as static.
	const fetch = () => Promise.reject(new Error('offline'));
	try {
		return await actions.default({ request, platform, url, fetch } as never);
	} catch (e) {
		if (isRedirect(e)) return 'saved';
		throw e;
	}
}

const artistNames = (sqlite: ReturnType<typeof makeDb>['sqlite']) =>
	(sqlite.prepare('SELECT name FROM artists ORDER BY id').all() as Array<{ name: string }>).map((r) => r.name);
const packs = (sqlite: ReturnType<typeof makeDb>['sqlite']) =>
	sqlite.prepare('SELECT published FROM sticker_packs').all() as Array<{ published: number }>;
const isPrivate = (sqlite: ReturnType<typeof makeDb>['sqlite']) =>
	(sqlite.prepare('SELECT ledger_private AS p FROM artists WHERE id = 2').get() as { p: number }).p;

// SONA-236: a published pack crediting a Keep private artist asks first.
describe('manual pack save with a Keep private artist', () => {
	it('refuses a published pack without confirmUnhide, and creates no pack or new artist', async () => {
		const { sqlite, platform } = makeDb();

		const result = await save(platform, packForm({ published: '1' }));
		expect(result).toMatchObject({ status: 409, data: { confirmUnhide: ['Quill'] } });
		expect(packs(sqlite)).toEqual([]);
		expect(artistNames(sqlite)).toEqual(['Quill']);
		expect(isPrivate(sqlite)).toBe(1);
	});

	it('saves with confirmUnhide=1, creates the new artist once, and clears Keep private', async () => {
		const { sqlite, platform } = makeDb();

		expect(await save(platform, packForm({ published: '1', confirmUnhide: '1' }))).toBe('saved');
		expect(packs(sqlite)).toEqual([{ published: 1 }]);
		expect(artistNames(sqlite)).toEqual(['Quill', 'Fresh']);
		expect(isPrivate(sqlite)).toBe(0);
	});

	it('saves an unpublished pack without asking', async () => {
		const { sqlite, platform } = makeDb();

		expect(await save(platform, packForm())).toBe('saved');
		expect(packs(sqlite)).toEqual([{ published: 0 }]);
		expect(isPrivate(sqlite)).toBe(1);
	});
});
