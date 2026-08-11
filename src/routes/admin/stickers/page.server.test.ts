import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { getDb } from '$lib/server/db';
import { stickerTabEnabled, clearStickerTabCache } from '$lib/server/stickers';

import { actions } from './+page.server';

// Only the table the togglePublished action touches.
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE sticker_packs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL DEFAULT '', slug TEXT NOT NULL DEFAULT '',
			description TEXT, cover_image_url TEXT, character_id INTEGER NOT NULL DEFAULT 1,
			manager_artist_id INTEGER, telegram_url TEXT, source TEXT NOT NULL DEFAULT 'self-hosted',
			published INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ''
		);
	`);
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
