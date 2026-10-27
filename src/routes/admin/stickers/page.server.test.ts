import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { PUBLIC_WORK_TABLES } from '$lib/server/test/public-work-tables';
import { getDb } from '$lib/server/db';
import { stickerTabEnabled, clearStickerTabCache } from '$lib/server/stickers';

import { actions } from './+page.server';

// Only the tables the togglePublished action touches.
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE sticker_packs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '',
			description TEXT, cover_image_url TEXT, character_id INTEGER NOT NULL DEFAULT 1,
			manager_artist_id INTEGER, telegram_url TEXT, source TEXT NOT NULL DEFAULT 'self-hosted',
			published INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE stickers (id INTEGER PRIMARY KEY AUTOINCREMENT, pack_id INTEGER NOT NULL, artist_id INTEGER);
		CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ledger_private INTEGER NOT NULL DEFAULT 0);
	`);
	sqlite.exec(PUBLIC_WORK_TABLES);
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

// The tab probe caches per-isolate; this pins that the publish flip clears it
// so the SAME isolate shows/hides the Stickers pill immediately (other
// isolates converge by TTL).
describe('togglePublished — tab probe cache invalidation', () => {
	it('clears the cached probe so the pill can flip immediately', async () => {
		const { sqlite, platform } = makeDb();
		sqlite.prepare('INSERT INTO sticker_packs (id, published) VALUES (1, 0)').run();
		const db = getDb(platform.env.DB);
		// Prime the cached probe with "no published pack exists".
		clearStickerTabCache();
		expect(await stickerTabEnabled(db)).toBe(false);

		const form = new FormData();
		form.set('id', '1');
		const request = new Request('http://localhost/admin/stickers?/togglePublished', {
			method: 'POST',
			body: form
		});
		await actions.togglePublished({ request, platform } as never);

		// No manual clear here — the action itself must have invalidated the
		// cache, or this still reads the primed `false` for up to the TTL.
		expect(await stickerTabEnabled(db)).toBe(true);
	});
});

// Publishing a pack that credits a Keep private artist asks first (SONA-236).
describe('togglePublished — Keep private artists', () => {
	type Sqlite = ReturnType<typeof makeDb>['sqlite'];
	function toggle(platform: App.Platform, fields: Record<string, string>) {
		const form = new FormData();
		for (const [k, v] of Object.entries(fields)) form.set(k, v);
		const request = new Request('http://localhost/admin/stickers?/togglePublished', { method: 'POST', body: form });
		return actions.togglePublished({ request, platform } as never);
	}
	function seed(sqlite: Sqlite, packPublished: 0 | 1, managerArtistId: number | null) {
		sqlite.exec(`INSERT INTO artists (id, name, ledger_private) VALUES (1, 'Quill', 1), (2, 'Open', 0), (3, 'Moth', 1)`);
		sqlite.prepare('INSERT INTO sticker_packs (id, published, manager_artist_id) VALUES (1, ?, ?)').run(packPublished, managerArtistId);
		sqlite.exec(`INSERT INTO stickers (pack_id, artist_id) VALUES (1, 1), (1, 1), (1, 2), (1, NULL)`);
	}
	const published = (sqlite: Sqlite) => sqlite.prepare('SELECT published FROM sticker_packs WHERE id = 1').get().published;
	const isPrivate = (sqlite: Sqlite, id: number) =>
		sqlite.prepare('SELECT ledger_private FROM artists WHERE id = ?').get(id).ledger_private;

	it('refuses to publish without confirmUnhide, names the sticker artist, and leaves the pack unpublished', async () => {
		const { sqlite, platform } = makeDb();
		seed(sqlite, 0, null);

		const result = await toggle(platform, { id: '1' });
		expect(result).toMatchObject({ status: 409, data: { confirmUnhide: ['Quill'] } });
		expect(published(sqlite)).toBe(0);
		expect(isPrivate(sqlite, 1)).toBe(1);
	});

	it('publishes with confirmUnhide=1 and clears Keep private', async () => {
		const { sqlite, platform } = makeDb();
		seed(sqlite, 0, null);

		expect(await toggle(platform, { id: '1', confirmUnhide: '1' })).toEqual({ toggled: true });
		expect(published(sqlite)).toBe(1);
		expect(isPrivate(sqlite, 1)).toBe(0);
	});

	it('asks about the manager and every stored sticker artist', async () => {
		const { sqlite, platform } = makeDb();
		// A pack managed by Moth holding a sticker saved under Quill, as a
		// re-import into the pack can leave it. The public pages show both.
		seed(sqlite, 0, 3);

		const result = (await toggle(platform, { id: '1' })) as { status: number; data: { confirmUnhide: string[] } };
		expect(result.status).toBe(409);
		expect([...result.data.confirmUnhide].sort()).toEqual(['Moth', 'Quill']);
		expect(published(sqlite)).toBe(0);

		await toggle(platform, { id: '1', confirmUnhide: '1' });
		expect(published(sqlite)).toBe(1);
		expect(isPrivate(sqlite, 3)).toBe(0);
		expect(isPrivate(sqlite, 1)).toBe(0);
	});

	it('unpublishes without asking', async () => {
		const { sqlite, platform } = makeDb();
		seed(sqlite, 1, null);

		expect(await toggle(platform, { id: '1' })).toEqual({ toggled: true });
		expect(published(sqlite)).toBe(0);
		expect(isPrivate(sqlite, 1)).toBe(1);
	});
});
