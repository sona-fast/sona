import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { asc } from 'drizzle-orm';
import { makeD1 } from '$lib/server/test/d1';
import { getDb } from '$lib/server/db';
import { artists } from '$lib/server/db/schema';
import { checkUnhide, clearKeepPrivate } from './artist-visibility';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
			global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
			aliases TEXT, avatar_resolved_at TEXT, ledger_private INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
		);
	`);
	return getDb(makeD1(sqlite));
}

async function seed(db: ReturnType<typeof makeDb>) {
	await db.insert(artists).values([
		{ id: 1, name: 'Open' },
		{ id: 2, name: 'Quill', ledgerPrivate: true },
		{ id: 3, name: 'Moth', ledgerPrivate: true }
	]);
}

function formData(fields: Record<string, string> = {}): FormData {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return fd;
}

const flags = async (db: ReturnType<typeof makeDb>) =>
	(await db.select({ id: artists.id, p: artists.ledgerPrivate }).from(artists).orderBy(asc(artists.id)).all()).map((r) => [r.id, r.p]);

describe('checkUnhide', () => {
	it('does not refuse an empty list', async () => {
		const db = makeDb();
		await seed(db);
		expect(await checkUnhide(db, formData(), [])).toEqual({ refusal: null, unhide: [] });
	});

	it('does not refuse null, undefined, or non-positive ids', async () => {
		const db = makeDb();
		await seed(db);
		expect(await checkUnhide(db, formData(), [null, undefined, 0, -2])).toEqual({ refusal: null, unhide: [] });
	});

	it('does not refuse artists who are not Keep private', async () => {
		const db = makeDb();
		await seed(db);
		expect(await checkUnhide(db, formData(), [1, 1, 99])).toEqual({ refusal: null, unhide: [] });
	});

	it('refuses with a 409 naming each Keep private artist once without confirmUnhide', async () => {
		const db = makeDb();
		await seed(db);
		const { refusal, unhide } = await checkUnhide(db, formData(), [1, 2, 2, null, 3]);
		expect(refusal?.status).toBe(409);
		expect([...refusal!.data.confirmUnhide].sort()).toEqual(['Moth', 'Quill']);
		expect(unhide).toEqual([]);
	});

	it('refuses when confirmUnhide is anything but 1', async () => {
		const db = makeDb();
		await seed(db);
		const { refusal } = await checkUnhide(db, formData({ confirmUnhide: 'true' }), [2]);
		expect(refusal?.status).toBe(409);
	});

	it('returns the Keep private ids to clear with confirmUnhide=1', async () => {
		const db = makeDb();
		await seed(db);
		const { refusal, unhide } = await checkUnhide(db, formData({ confirmUnhide: '1' }), [1, 2, 2, 3]);
		expect(refusal).toBeNull();
		expect([...unhide].sort()).toEqual([2, 3]);
		// Checking alone writes nothing.
		expect(await flags(db)).toEqual([
			[1, false],
			[2, true],
			[3, true]
		]);
	});
});

describe('clearKeepPrivate', () => {
	it('clears only the given ids', async () => {
		const db = makeDb();
		await seed(db);
		await clearKeepPrivate(db, [2]);
		expect(await flags(db)).toEqual([
			[1, false],
			[2, false],
			[3, true]
		]);
	});

	it('changes nothing for an empty list', async () => {
		const db = makeDb();
		await seed(db);
		await clearKeepPrivate(db, []);
		expect(await flags(db)).toEqual([
			[1, false],
			[2, true],
			[3, true]
		]);
	});
});
