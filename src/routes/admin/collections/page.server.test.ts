import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { getDb } from '$lib/server/db';
import { collectionsNavEnabled, clearCollectionsNavCache } from '$lib/server/collections';

import { actions } from './+page.server';

// Only the tables the collections actions touch, columns limited to what
// their queries reference.
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE collections (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
			cover_image_url TEXT, created_at TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, collection_id INTEGER);
	`);
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

async function post(
	action: 'create' | 'delete',
	platform: App.Platform,
	fields: Record<string, string>
) {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	const request = new Request('http://localhost/admin/collections', {
		method: 'POST',
		body: form
	});
	return actions[action]({ request, platform } as never);
}

// The nav probe caches per-isolate; these pin that the write actions clear it
// so the SAME isolate shows/hides the Collections link immediately (other
// isolates converge by TTL).
describe('collections actions — nav probe cache invalidation', () => {
	it('create clears the cached probe so the nav link can appear immediately', async () => {
		const { platform } = makeDb();
		const db = getDb(platform.env.DB);
		// Prime the cached probe with "no collection exists".
		clearCollectionsNavCache();
		expect(await collectionsNavEnabled(db)).toBe(false);

		await post('create', platform, { name: 'Con badges' });

		// No manual clear here — the action itself must have invalidated the
		// cache, or this still reads the primed `false` for up to the TTL.
		expect(await collectionsNavEnabled(db)).toBe(true);
	});

	it('delete clears the cached probe so the nav link can drop immediately', async () => {
		const { sqlite, platform } = makeDb();
		sqlite.prepare("INSERT INTO collections (id, name, slug) VALUES (1, 'Con badges', 'con-badges')").run();
		const db = getDb(platform.env.DB);
		clearCollectionsNavCache();
		expect(await collectionsNavEnabled(db)).toBe(true);

		await post('delete', platform, { id: '1' });

		expect(await collectionsNavEnabled(db)).toBe(false);
	});
});
