import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { animatedWebp, staticWebp } from '$lib/server/test/raster-fixtures';
import { POST } from './+server';

const ORIGIN = 'https://site.example';

// Seeded rows, in id order. The two raster flags are deliberately WRONG in
// opposite directions; the 404 row's flag (true) must survive a failed fetch.
const ROWS = [
	{ id: 1, format: 'animated', imageUrl: '/img/l.json', isAnimated: 0 }, // Lottie, wrong
	{ id: 2, format: 'video', imageUrl: '/img/v.webm', isAnimated: 0 }, // video, wrong
	{ id: 3, format: 'webp', imageUrl: '/img/anim.webp', isAnimated: 0 }, // animated raster, wrong
	{ id: 4, format: 'webp', imageUrl: '/img/still.webp', isAnimated: 1 }, // static raster, wrong
	{ id: 5, format: 'png', imageUrl: '/img/gone.webp', isAnimated: 1 } // fetch 404s
];

function seedDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE stickers (id INTEGER PRIMARY KEY, image_url TEXT, format TEXT, is_animated INTEGER DEFAULT 0);
	`);
	for (const r of ROWS) {
		sqlite
			.prepare('INSERT INTO stickers (id, image_url, format, is_animated) VALUES (?, ?, ?, ?)')
			.run(r.id, r.imageUrl, r.format, r.isAnimated);
	}
	return { db: makeD1(sqlite), sqlite };
}

// Serves the raster fixtures by resolved URL; /img/gone.webp 404s.
const fetchByUrl = vi.fn(async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url === `${ORIGIN}/img/anim.webp`) return new Response(animatedWebp().buffer as ArrayBuffer);
	if (url === `${ORIGIN}/img/still.webp`) return new Response(staticWebp().buffer as ArrayBuffer);
	return new Response('nope', { status: 404 });
}) as typeof fetch;

function makeEvent(db: ReturnType<typeof makeD1>, search = '') {
	return {
		url: new URL(`${ORIGIN}/api/stickers/backfill-animated${search}`),
		platform: { env: { DB: db } },
		fetch: fetchByUrl
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

function flags(sqlite: ReturnType<typeof seedDb>['sqlite']): Record<number, number> {
	const out: Record<number, number> = {};
	for (const r of sqlite.prepare('SELECT id, is_animated AS a FROM stickers').all() as Array<{ id: number; a: number }>) {
		out[r.id] = r.a;
	}
	return out;
}

describe('POST /api/stickers/backfill-animated', () => {
	it('corrects wrong flags in both directions, never stamps an unreadable row, and is idempotent', async () => {
		const { db, sqlite } = seedDb();

		const first = await (await POST(makeEvent(db))).json();
		expect(first).toMatchObject({ rasters: 3, updated: 2, unchanged: 0, lastId: 5 });
		expect(first.failed).toEqual([{ id: 5, error: 'could not fetch stored file' }]);

		expect(flags(sqlite)).toEqual({
			1: 1, // Lottie bulk-stamped animated
			2: 1, // video bulk-stamped animated
			3: 1, // animated WebP corrected static → animated
			4: 0, // static raster corrected animated → static
			5: 1 // failed fetch: flag KEPT, not stamped static
		});

		// Second run: nothing left to change (the unreadable row still reports).
		const second = await (await POST(makeEvent(db))).json();
		expect(second).toMatchObject({ rasters: 3, updated: 0, unchanged: 2 });
		expect(second.failed).toHaveLength(1);
	});

	it('pages rasters with ?limit and ?afterId, returning lastId for the next run', async () => {
		const { db } = seedDb();

		const page1 = await (await POST(makeEvent(db, '?limit=1'))).json();
		expect(page1).toMatchObject({ rasters: 1, updated: 1, lastId: 3 });

		const page2 = await (await POST(makeEvent(db, `?limit=1&afterId=${page1.lastId}`))).json();
		expect(page2).toMatchObject({ rasters: 1, updated: 1, lastId: 4 });

		const page3 = await (await POST(makeEvent(db, `?limit=10&afterId=${page2.lastId}`))).json();
		expect(page3).toMatchObject({ rasters: 1, updated: 0, lastId: 5 });
		expect(page3.failed).toHaveLength(1);
	});
});
