import { describe, it, expect, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { conventions } from '$lib/server/db/schema';
import { load } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

type ConventionRow = typeof conventions.$inferSelect;
type ConnectData = { conventions: ConventionRow[]; liveConvention: ConventionRow | null };

// The load result needs an explicit shape: PageServerLoad's declared return type
// includes void, so property access on the raw result does not typecheck. Same
// cast the other page.server tests use.
async function loadData(platform: App.Platform): Promise<ConnectData> {
	return (await load({ platform } as never)) as ConnectData;
}

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE conventions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			location TEXT,
			start_date TEXT NOT NULL,
			end_date TEXT,
			url TEXT,
			status TEXT NOT NULL DEFAULT 'confirmed',
			source_id TEXT,
			timezone TEXT,
			created_at TEXT NOT NULL
		);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

// Tails of Summer 2026: two days, America/Vancouver (UTC-7). The event this was
// built against, and a useful worst case — its closing day ends at 17:00 local.
const TAILS = {
	name: 'Tails of Summer 2026',
	location: 'Vancouver, BC',
	startDate: '2026-08-08',
	endDate: '2026-08-09',
	timezone: 'America/Vancouver',
	status: 'confirmed',
	createdAt: '2026-01-01T00:00:00.000Z'
};

function at(iso: string) {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(iso));
}

afterEach(() => {
	vi.useRealTimers();
});

describe('connect load — live convention', () => {
	it('reports the convention as live during it, and keeps it out of the upcoming list', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values(TAILS);
		at('2026-08-08T18:00:00Z'); // 11:00 Saturday in Vancouver

		const res = await loadData(platform);
		expect(res.liveConvention?.name).toBe('Tails of Summer 2026');
		// Never rendered twice: it is the here-now block, so it is not also a row.
		expect(res.conventions).toEqual([]);
	});

	it('is still live late on the closing day, after UTC has rolled over', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values(TAILS);
		// 19:00 Sunday in Vancouver. In UTC it is already the 10th, and both the
		// old SQL filter and a naive date compare would call the con finished
		// while people are still in the building.
		at('2026-08-10T02:00:00Z');

		const res = await loadData(platform);
		expect(res.liveConvention?.name).toBe('Tails of Summer 2026');
	});

	it('is not live the evening before it opens', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values(TAILS);
		at('2026-08-08T01:00:00Z'); // 18:00 Friday the 7th in Vancouver

		const res = await loadData(platform);
		expect(res.liveConvention).toBeNull();
		expect(res.conventions.map((c) => c.name)).toEqual(['Tails of Summer 2026']);
	});

	it('is not live once the closing day is over locally, and drops off the list', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values(TAILS);
		at('2026-08-10T08:00:00Z'); // 01:00 Monday in Vancouver

		const res = await loadData(platform);
		expect(res.liveConvention).toBeNull();
		expect(res.conventions).toEqual([]);
	});

	it('never goes live for a convention the operator only marked considering', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values({ ...TAILS, status: 'considering' });
		at('2026-08-08T18:00:00Z');

		const res = await loadData(platform);
		expect(res.liveConvention).toBeNull();
		// Still listed: a maybe is useful to a visitor, it just must not claim presence.
		expect(res.conventions.map((c) => c.name)).toEqual(['Tails of Summer 2026']);
	});

	it('falls back to a day of margin when the row has no timezone', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values({ ...TAILS, timezone: null });
		at('2026-08-10T12:00:00Z'); // a day past the end in UTC

		const res = await loadData(platform);
		// Errs toward showing rather than going dark on an un-backfilled row.
		expect(res.liveConvention?.name).toBe('Tails of Summer 2026');
	});

	it('picks the running convention even when an earlier one is listed first', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values([
			{ ...TAILS, name: 'Earlier con', startDate: '2026-08-01', endDate: '2026-08-02' },
			TAILS
		]);
		at('2026-08-08T18:00:00Z');

		const res = await loadData(platform);
		expect(res.liveConvention?.name).toBe('Tails of Summer 2026');
		// The finished one is gone; only genuinely upcoming rows remain.
		expect(res.conventions).toEqual([]);
	});
});
