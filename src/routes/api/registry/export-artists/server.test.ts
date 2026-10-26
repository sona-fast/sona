import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { artists } from '$lib/server/db/schema';
import { makeD1 } from '$lib/server/test/d1';
import { GET } from './+server';

const now = '2026-10-01';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE artists (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
		global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
		aliases TEXT, avatar_resolved_at TEXT, ledger_private INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
	);
	CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 1, parent_image_id INTEGER);
	CREATE TABLE stickers (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER, pack_id INTEGER);
	CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY AUTOINCREMENT, manager_artist_id INTEGER, published INTEGER NOT NULL DEFAULT 1);
	CREATE TABLE avatar_credits (avatar_id INTEGER NOT NULL, artist_id INTEGER NOT NULL);
	CREATE TABLE vr_avatars (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
	CREATE TABLE commissions (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER NOT NULL);`);
	const d1 = makeD1(sqlite);
	const platform = { env: { DB: d1 } } as unknown as App.Platform;
	return { db: drizzle(d1, { schema }), platform };
}

async function exportedNames(platform: App.Platform): Promise<string[]> {
	const res = await GET({ platform } as never);
	return ((await res.json()) as { name: string }[]).map((a) => a.name);
}

// SONA-236: the export seeds a registry, so it follows the daily sync's rule and
// leaves out artists who are private to the owner's commission ledger.
describe('GET /api/registry/export-artists', () => {
	it('leaves out Keep private artists with no public work and keeps everyone else', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values([
			{ id: 1, name: 'entries only', createdAt: now },
			{ id: 2, name: 'flagged, no public work', ledgerPrivate: true, createdAt: now },
			{ id: 3, name: 'flagged, published piece', ledgerPrivate: true, createdAt: now },
			{ id: 4, name: 'entries and a draft piece', createdAt: now },
			{ id: 5, name: 'plain', createdAt: now }
		]);
		await db.run(sql`INSERT INTO commissions (artist_id) VALUES (1), (4)`);
		await db.run(sql`INSERT INTO images (artist_id, published) VALUES (3, 1), (4, 0)`);

		const names = await exportedNames(platform);
		// Entries alone don't hide an artist; only the Keep private box does (SONA-236).
		expect(names.sort()).toEqual(['entries and a draft piece', 'entries only', 'flagged, published piece', 'plain']);
	});
});
