import { describe, it, expect, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { conventions } from '$lib/server/db/schema';

import { makeD1 } from '$lib/server/test/d1';

// The load offers cons.fyi events that are not on the schedule yet, which is a
// network call. Stubbed out: nothing here is about the feed.
vi.mock('$lib/server/consfyi', () => ({
	fetchConsFyiEvents: vi.fn(async () => []),
	findConsFyiEvent: vi.fn(async () => undefined),
	fetchAttendingEvents: vi.fn(async () => []),
	blueskyHandle: vi.fn(() => null)
}));

const { load } = await import('./+page.server');

type ConventionRow = typeof conventions.$inferSelect;
type ConventionsData = { conventions: ConventionRow[]; liveId: number | null };

// The load result needs an explicit shape: PageServerLoad's declared return type
// includes void, so property access on the raw result does not typecheck. Same
// cast the other page.server tests use.
async function loadData(platform: App.Platform): Promise<ConventionsData> {
	return (await load({ platform } as never)) as ConventionsData;
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

// Tails of Summer 2026: two days, America/Vancouver (UTC-7). Same fixture the
// public connect load is tested against.
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

describe('admin conventions load', () => {
	it('returns the timezone on every row, so the list can show it', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values([TAILS, { ...TAILS, name: 'Manual con', timezone: null }]);
		at('2026-01-01T00:00:00Z');

		const res = await loadData(platform);
		expect(res.conventions.map((c) => c.timezone)).toEqual(['America/Vancouver', null]);
	});

	it('marks the confirmed convention running right now as live', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values(TAILS);
		at('2026-08-08T18:00:00Z'); // 11:00 Saturday in Vancouver

		const res = await loadData(platform);
		expect(res.liveId).toBe(res.conventions[0].id);
	});

	it('never goes live for a convention the operator only marked considering', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values({ ...TAILS, status: 'considering' });
		at('2026-08-08T18:00:00Z');

		const res = await loadData(platform);
		// The dates line up perfectly. Presence is still not being claimed, so the
		// launcher must not appear on the row.
		expect(res.liveId).toBeNull();
		// The row itself is untouched: admin lists everything, live or not.
		expect(res.conventions).toHaveLength(1);
	});

	it('picks the running row, not a considering one running the same days', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values([
			{ ...TAILS, name: 'Considering con', status: 'considering' },
			TAILS
		]);
		at('2026-08-08T18:00:00Z');

		const res = await loadData(platform);
		const live = res.conventions.find((c) => c.id === res.liveId);
		expect(live?.name).toBe('Tails of Summer 2026');
	});

	it('is not live once the closing day is over in the event zone', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values(TAILS);
		at('2026-08-10T08:00:00Z'); // 01:00 Monday in Vancouver

		const res = await loadData(platform);
		expect(res.liveId).toBeNull();
		// Past cons stay on the admin list; only the live marker goes away.
		expect(res.conventions).toHaveLength(1);
	});

	it('is still live late on the closing day, after UTC has rolled over', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values(TAILS);
		// 19:00 Sunday in Vancouver, already the 10th in UTC. The launcher has to
		// survive this: it is the last afternoon of the con, when it is most used.
		at('2026-08-10T02:00:00Z');

		const res = await loadData(platform);
		expect(res.liveId).toBe(res.conventions[0].id);
	});
});
