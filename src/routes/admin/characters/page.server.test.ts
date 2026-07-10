import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { characters } from '$lib/server/db/schema';
import { actions } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE characters (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
		is_owner INTEGER NOT NULL DEFAULT 0, reference_image_id INTEGER, created_at TEXT NOT NULL
	);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

// Only name + isOwner matter here; omitting url/bluesky keeps resolveCharacterIcon
// offline (it returns null without a fetch), so the save path stays hermetic.
function form(fields: Record<string, string>): { request: Request } {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return { request: new Request('http://localhost/admin/characters', { method: 'POST', body: fd }) };
}

async function isOwnerOf(db: ReturnType<typeof makeDb>['db'], id: number) {
	const row = await db.select({ isOwner: characters.isOwner }).from(characters).where(eq(characters.id, id)).get();
	return row?.isOwner;
}

describe('admin characters save path — is_owner', () => {
	it('update sets is_owner true when the checkbox is on', async () => {
		const { db, platform } = makeDb();
		const [c] = await db.insert(characters).values({ name: 'Taro' }).returning({ id: characters.id });
		expect(await isOwnerOf(db, c.id)).toBe(false);

		await actions.update({ ...form({ id: String(c.id), name: 'Taro', isOwner: 'on' }), platform } as never);
		expect(await isOwnerOf(db, c.id)).toBe(true);
	});

	it('update clears is_owner when the checkbox is absent', async () => {
		const { db, platform } = makeDb();
		const [c] = await db.insert(characters).values({ name: 'Taro', isOwner: true }).returning({ id: characters.id });
		expect(await isOwnerOf(db, c.id)).toBe(true);

		await actions.update({ ...form({ id: String(c.id), name: 'Taro' }), platform } as never);
		expect(await isOwnerOf(db, c.id)).toBe(false);
	});

	it('create honors the is_owner checkbox', async () => {
		const { db, platform } = makeDb();
		await actions.create({ ...form({ name: 'Owner', isOwner: 'on' }), platform } as never);
		const row = await db.select({ isOwner: characters.isOwner }).from(characters).where(eq(characters.name, 'Owner')).get();
		expect(row?.isOwner).toBe(true);
	});
});
