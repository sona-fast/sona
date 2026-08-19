import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { asc, eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { conventions, siteSettings } from '$lib/server/db/schema';
import { clearSettingsCache } from '$lib/server/settings';
import type { ConsFyiEvent } from '$lib/server/consfyi';

import { makeD1 } from '$lib/server/test/d1';

// The load offers cons.fyi events that are not on the schedule yet, which is a
// network call. Stubbed out: nothing here is about the feed. The sync tests below
// drive the same mocks per test, so the actions see the events they need.
vi.mock('$lib/server/consfyi', () => ({
	fetchConsFyiEvents: vi.fn(async () => []),
	findConsFyiEvent: vi.fn(async () => undefined),
	fetchAttendingEvents: vi.fn(async () => []),
	blueskyHandle: vi.fn(() => null)
}));

const { load, actions } = await import('./+page.server');
const consfyi = await import('$lib/server/consfyi');

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
	// site_settings: the sync action reads the operator's Bluesky URL out of it.
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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

// The timezone is what decides whether a row goes live, so where it comes from
// is worth pinning: the feed on the way in, and a backfill for the rows that
// predate the column. Without the backfill the rollout needs a manual pass over
// every fork's database, which is nobody's job.
describe('cons.fyi sync: timezone', () => {
	/** A cons.fyi feed event, in the shape fetchAttendingEvents returns. */
	function event(overrides: Partial<ConsFyiEvent> = {}): ConsFyiEvent {
		return {
			id: 'mff-2026',
			name: 'Midwest FurFest 2026',
			url: 'https://furfest.org',
			startDate: '2026-12-03',
			endDate: '2026-12-06',
			location: 'Rosemont, IL',
			timezone: 'America/Chicago',
			...overrides
		};
	}

	/** Point the feed mocks at `events`, with a Bluesky handle configured. */
	async function attending(db: ReturnType<typeof drizzle>, events: ConsFyiEvent[]) {
		clearSettingsCache();
		await db.insert(siteSettings).values({ key: 'blueskyUrl', value: 'https://bsky.app/profile/taro.surf' });
		vi.mocked(consfyi.blueskyHandle).mockReturnValue('taro.surf');
		vi.mocked(consfyi.fetchAttendingEvents).mockResolvedValue(events);
	}

	async function sync(platform: App.Platform): Promise<{ message?: string }> {
		return (await actions.sync({ platform } as never)) as { message?: string };
	}

	function rows(db: ReturnType<typeof drizzle>) {
		return db.select().from(conventions).orderBy(asc(conventions.id));
	}

	afterEach(() => {
		clearSettingsCache();
		vi.mocked(consfyi.blueskyHandle).mockReturnValue(null);
		vi.mocked(consfyi.fetchAttendingEvents).mockResolvedValue([]);
		vi.mocked(consfyi.findConsFyiEvent).mockResolvedValue(undefined);
	});

	it('fills in the zone on a row that was added before the column existed', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values({
			...TAILS,
			name: 'Midwest FurFest 2026',
			sourceId: 'mff-2026',
			timezone: null
		});
		await attending(db, [event()]);

		const result = await sync(platform);

		expect((await rows(db))[0].timezone).toBe('America/Chicago');
		// The count is reported: a silent backfill is indistinguishable from none.
		expect(result.message).toContain('1 convention');
	});

	it('never overwrites a zone the row already has', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values({
			...TAILS,
			name: 'Midwest FurFest 2026',
			sourceId: 'mff-2026',
			timezone: 'America/Vancouver'
		});
		// The feed disagrees. The stored zone stands: it may have been corrected by
		// hand, and the isNull guard is what makes the backfill safe to re-run.
		await attending(db, [event({ timezone: 'America/Denver' })]);

		const result = await sync(platform);

		expect((await rows(db))[0].timezone).toBe('America/Vancouver');
		expect(result.message).toContain('Already in sync');
	});

	it('counts every row it filled, and only those', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values([
			{ ...TAILS, name: 'One', sourceId: 'one', timezone: null },
			{ ...TAILS, name: 'Two', sourceId: 'two', timezone: null },
			{ ...TAILS, name: 'Three', sourceId: 'three', timezone: 'America/Vancouver' }
		]);
		await attending(db, [
			event({ id: 'one', timezone: 'America/Chicago' }),
			event({ id: 'two', timezone: 'America/New_York' }),
			event({ id: 'three', timezone: 'America/Denver' })
		]);

		const result = await sync(platform);

		expect((await rows(db)).map((c) => c.timezone)).toEqual([
			'America/Chicago',
			'America/New_York',
			'America/Vancouver'
		]);
		expect(result.message).toContain('2 conventions');
	});

	it('carries the zone in on a con the sync adds', async () => {
		const { db, platform } = makeDb();
		await attending(db, [event()]);

		await sync(platform);

		expect(await rows(db)).toMatchObject([
			{ name: 'Midwest FurFest 2026', sourceId: 'mff-2026', timezone: 'America/Chicago' }
		]);
	});

	it('carries the zone in on a con picked from the feed by hand', async () => {
		const { db, platform } = makeDb();
		vi.mocked(consfyi.findConsFyiEvent).mockResolvedValue(event());
		const body = new FormData();
		body.append('sourceId', 'mff-2026');

		await actions.addFromSource({
			platform,
			request: new Request('https://taro.surf/admin/conventions?/addFromSource', {
				method: 'POST',
				body
			})
		} as never);

		expect(await rows(db)).toMatchObject([{ sourceId: 'mff-2026', timezone: 'America/Chicago' }]);
	});

	it('leaves the zone null when the feed event carries none', async () => {
		const { db, platform } = makeDb();
		await attending(db, [event({ timezone: undefined })]);

		await sync(platform);

		expect((await rows(db))[0].timezone).toBeNull();
	});

	it('leaves a zone alone when another writer fills it between the read and the write', async () => {
		const { db, platform } = makeDb();
		await db.insert(conventions).values({
			...TAILS,
			name: 'Midwest FurFest 2026',
			sourceId: 'mff-2026',
			timezone: null
		});
		await attending(db, [event({ timezone: 'America/Chicago' })]);

		// The backfill decides from a SELECT and writes later, so the isNull in its
		// WHERE is the only thing standing between a hand-corrected zone and the
		// feed's. Slip that correction in at the batch boundary, which is the one
		// moment the race has, and the guard either holds or the fix is decorative.
		const d1 = platform.env!.DB;
		const realBatch = d1.batch.bind(d1);
		d1.batch = (async (statements: never) => {
			await db
				.update(conventions)
				.set({ timezone: 'America/Denver' })
				.where(eq(conventions.sourceId, 'mff-2026'));
			return realBatch(statements);
		}) as typeof d1.batch;

		const result = await sync(platform);

		expect((await rows(db))[0].timezone).toBe('America/Denver');
		// Counted from what the sync decided to write, not from what landed: the
		// message is about the attempt, and the row it names is genuinely filled in.
		expect(result.message).toContain('1 convention');
	});
});

// The feed is a third party, and a convention's url is rendered as an href on the
// public schedule. Both ingest paths run it through the same sanitizeUrl gate the
// hand-typed form uses, so a javascript: href can't reach the page through
// cons.fyi (or through a DNS answer for it) when it can't reach it by hand.
describe('cons.fyi ingest: url sanitizing', () => {
	function event(overrides: Partial<ConsFyiEvent> = {}): ConsFyiEvent {
		return {
			id: 'mff-2026',
			name: 'Midwest FurFest 2026',
			url: 'javascript:alert(1)',
			startDate: '2026-12-03',
			endDate: '2026-12-06',
			location: 'Rosemont, IL',
			timezone: 'America/Chicago',
			...overrides
		};
	}

	afterEach(() => {
		clearSettingsCache();
		vi.mocked(consfyi.blueskyHandle).mockReturnValue(null);
		vi.mocked(consfyi.fetchAttendingEvents).mockResolvedValue([]);
		vi.mocked(consfyi.findConsFyiEvent).mockResolvedValue(undefined);
	});

	it('stores null for a javascript: url the sync brings in', async () => {
		const { db, platform } = makeDb();
		clearSettingsCache();
		await db.insert(siteSettings).values({ key: 'blueskyUrl', value: 'https://bsky.app/profile/taro.surf' });
		vi.mocked(consfyi.blueskyHandle).mockReturnValue('taro.surf');
		vi.mocked(consfyi.fetchAttendingEvents).mockResolvedValue([event()]);

		await actions.sync({ platform } as never);

		const stored = await db.select().from(conventions).orderBy(asc(conventions.id));
		// The row is still added: the con is real, only its link is not.
		expect(stored).toMatchObject([{ sourceId: 'mff-2026', url: null }]);
	});

	it('nulls a javascript: url already stored on a synced row, on the next sync', async () => {
		// The gate is new; the rows it protects are not. A url that reached the
		// schedule through the feed before the gate existed is still an href on the
		// public page, and the sync already reads every row and writes one batch.
		const { db, platform } = makeDb();
		clearSettingsCache();
		await db.insert(siteSettings).values({ key: 'blueskyUrl', value: 'https://bsky.app/profile/taro.surf' });
		await db.insert(conventions).values({
			name: 'Midwest FurFest 2026',
			startDate: '2026-12-03',
			url: 'javascript:alert(1)',
			status: 'confirmed',
			sourceId: 'mff-2026'
		});
		vi.mocked(consfyi.blueskyHandle).mockReturnValue('taro.surf');
		vi.mocked(consfyi.fetchAttendingEvents).mockResolvedValue([event({ url: 'https://furfest.org' })]);

		await actions.sync({ platform } as never);

		expect(await db.select().from(conventions)).toMatchObject([
			{ sourceId: 'mff-2026', url: null }
		]);
	});

	it('leaves a good url on a synced row alone', async () => {
		// The other direction: a re-run that nulls everything would pass the test
		// above and quietly wipe every link on the schedule.
		const { db, platform } = makeDb();
		clearSettingsCache();
		await db.insert(siteSettings).values({ key: 'blueskyUrl', value: 'https://bsky.app/profile/taro.surf' });
		await db.insert(conventions).values({
			name: 'Midwest FurFest 2026',
			startDate: '2026-12-03',
			url: 'https://furfest.org',
			status: 'confirmed',
			sourceId: 'mff-2026'
		});
		vi.mocked(consfyi.blueskyHandle).mockReturnValue('taro.surf');
		vi.mocked(consfyi.fetchAttendingEvents).mockResolvedValue([event()]);

		await actions.sync({ platform } as never);

		expect(await db.select().from(conventions)).toMatchObject([{ url: 'https://furfest.org' }]);
	});

	it('stores null for a javascript: url picked from the feed by hand', async () => {
		const { db, platform } = makeDb();
		vi.mocked(consfyi.findConsFyiEvent).mockResolvedValue(event());
		const body = new FormData();
		body.append('sourceId', 'mff-2026');

		await actions.addFromSource({
			platform,
			request: new Request('https://taro.surf/admin/conventions?/addFromSource', {
				method: 'POST',
				body
			})
		} as never);

		expect(await db.select().from(conventions)).toMatchObject([{ url: null }]);
	});

	it('keeps a real https url through both paths', async () => {
		// The other direction: a gate that nulls everything would pass the two above.
		const { db, platform } = makeDb();
		vi.mocked(consfyi.findConsFyiEvent).mockResolvedValue(event({ url: 'https://furfest.org' }));
		const body = new FormData();
		body.append('sourceId', 'mff-2026');

		await actions.addFromSource({
			platform,
			request: new Request('https://taro.surf/admin/conventions?/addFromSource', {
				method: 'POST',
				body
			})
		} as never);

		expect(await db.select().from(conventions)).toMatchObject([{ url: 'https://furfest.org' }]);
	});
});

// Source-pin for the page itself, per the con-card-markup.test.ts precedent:
// nothing renders this component under the pure-TS vitest setup, and what the
// live row does is a decision rather than styling.
const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('admin conventions page: the live row', () => {
	it('hands off to the QR with a plain link, not a scripted navigation', () => {
		// /connect/qr is public, so the scan target still loads when admin has
		// failed closed on a D1 outage, or when convention wifi left the session
		// cookie in pieces. A goto() or a submit button needs the app working
		// first, which is exactly the moment the operator is standing at a table.
		expect(pageSource).toMatch(/<a href="\/connect\/qr"/);
		expect(pageSource).not.toMatch(/goto\(/);
		expect(pageSource).not.toMatch(/<button[^>]*qr-btn/);
	});

	it('shows the live pill in place of the status chip, never beside it', () => {
		// Both are the row's status. Rendered together the row would claim to be
		// live and upcoming at once, so the pill is the {#if} and the chip the
		// {:else}, in the table and in the mobile list alike.
		const branches = [
			...pageSource.matchAll(
				/\{#if live\}\s*<span class="live-pill">[\s\S]*?\{:else\}\s*<span class="status status-\{con\.status\}">[\s\S]*?\{\/if\}/g
			)
		];
		expect(branches).toHaveLength(2);
	});

	it('carries the QR link in both the table and the mobile list', () => {
		// The operator is on a phone at the table as often as at a desk, and a
		// layout that drops the link hides the whole point of the live row.
		expect([...pageSource.matchAll(/<a href="\/connect\/qr"/g)]).toHaveLength(2);
		expect(pageSource).toMatch(/qr-btn mobile-qr/);
	});
});
