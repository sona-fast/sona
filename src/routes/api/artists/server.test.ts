import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { artists } from '$lib/server/db/schema';
import { POST } from './+server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE artists (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
		global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
		aliases TEXT, created_at TEXT NOT NULL
	);`);
	const d1 = makeD1(sqlite);
	const platform = { env: { DB: d1 } } as unknown as App.Platform;
	return { db: drizzle(d1, { schema }), platform };
}

function post(platform: App.Platform, body: Record<string, unknown>) {
	return POST({
		platform,
		request: new Request('https://sparky.ink/api/artists', {
			method: 'POST',
			body: JSON.stringify(body)
		})
	} as never);
}

const GID = 'g-furfoggy';

describe('POST /api/artists — explicit registry import overrides the local copy', () => {
	it('reused: refreshes a linked local artist with the registry fields', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({
			name: 'furfoggy (old)',
			globalId: GID,
			registryVersion: 1,
			avatarUrl: null,
			twitterUrl: 'https://x.com/furfoggy',
			createdAt: '2026-07-01'
		});

		const res = await post(platform, {
			name: 'FurFoggy',
			globalId: GID,
			registryVersion: 3,
			twitter: 'https://x.com/furfoggy',
			instagram: 'https://instagram.com/furfoggy',
			avatarUrl: 'https://pbs.twimg.com/profile_images/1/ff_400x400.jpg'
		});
		expect(((await res.json()) as { status: string }).status).toBe('reused');

		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.name).toBe('FurFoggy');
		expect(row!.avatarUrl).toBe('https://pbs.twimg.com/profile_images/1/ff_400x400.jpg');
		expect(row!.instagramUrl).toContain('instagram.com/furfoggy');
		expect(row!.registryVersion).toBe(3);
		expect(row!.registrySyncedAt).toBeTruthy();
	});

	it('reused: a field the registry lacks never blanks the local value', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({
			name: 'Kept',
			globalId: GID,
			telegramUrl: 'https://t.me/keptlocal',
			avatarUrl: 'https://cdn.example/local.png',
			createdAt: '2026-07-01'
		});

		await post(platform, { name: 'Kept', globalId: GID, registryVersion: 2 });

		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.telegramUrl).toBe('https://t.me/keptlocal'); // registry sent none
		expect(row!.avatarUrl).toBe('https://cdn.example/local.png'); // no registry avatar → kept
	});

	it('reused: a missing/non-finite registryVersion never blanks the local version', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({
			name: 'Versioned',
			globalId: GID,
			registryVersion: 7,
			createdAt: '2026-07-01'
		});

		// A refresh call that omits registryVersion must leave the stored one intact.
		await post(platform, { name: 'Versioned', globalId: GID });

		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.registryVersion).toBe(7);
	});

	it('linked: an unlinked handle-match gets linked AND refreshed', async () => {
		const { db, platform } = makeDb();
		await db.insert(artists).values({
			name: 'furfoggy',
			twitterUrl: 'https://x.com/furfoggy',
			createdAt: '2026-07-01'
		});

		const res = await post(platform, {
			name: 'FurFoggy',
			globalId: GID,
			registryVersion: 5,
			twitter: 'https://x.com/furfoggy',
			avatarUrl: 'https://pbs.twimg.com/profile_images/1/ff_400x400.jpg'
		});
		expect(((await res.json()) as { status: string }).status).toBe('linked');

		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.name).toBe('FurFoggy');
		expect(row!.avatarUrl).toContain('ff_400x400');
		expect(row!.registryVersion).toBe(5);
	});

	it('created: no local match still creates a fresh artist', async () => {
		const { db, platform } = makeDb();
		const res = await post(platform, {
			name: 'Brand New',
			globalId: GID,
			registryVersion: 1,
			twitter: 'https://x.com/brandnew'
		});
		expect(((await res.json()) as { status: string }).status).toBe('created');
		const row = await db.select().from(artists).where(eq(artists.globalId, GID)).get();
		expect(row!.name).toBe('Brand New');
	});
});
