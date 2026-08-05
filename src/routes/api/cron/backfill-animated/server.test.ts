import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { animatedWebp, staticWebp } from '$lib/server/test/raster-fixtures';
import { POST } from './+server';

const CRON_SECRET = 'test-cron-secret';

// The cron twin of /api/stickers/backfill-animated: same logic (covered by the
// admin endpoint's suite), different auth. This endpoint is EXEMPT from the
// admin gate in hooks, so its own bearer check is the only thing between the
// public internet and a bulk data job — these tests pin that boundary plus one
// delegation sanity check in each direction.

function seedDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE stickers (id INTEGER PRIMARY KEY, pack_id INTEGER, image_url TEXT, format TEXT, is_animated INTEGER DEFAULT 0);
		CREATE TABLE job_run (name TEXT PRIMARY KEY, status TEXT, ran_at TEXT, detail TEXT);
	`);
	sqlite
		.prepare('INSERT INTO stickers (id, pack_id, image_url, format, is_animated) VALUES (1, 1, ?, ?, 0)')
		.run('https://cdn.example.com/a.webp', 'webp');
	return makeD1(sqlite);
}

function postEvent(env: Record<string, unknown>, { secret = CRON_SECRET, bytes = animatedWebp() } = {}) {
	const url = new URL('http://localhost/api/cron/backfill-animated');
	const request = new Request(url, {
		method: 'POST',
		headers: secret ? { authorization: `Bearer ${secret}` } : {}
	});
	const fetchFn = vi.fn(async () => new Response(bytes.buffer as ArrayBuffer));
	return { request, url, platform: { env }, fetch: fetchFn } as never;
}

describe('POST /api/cron/backfill-animated', () => {
	it('fails closed with 503 when CRON_SECRET is not configured', async () => {
		await expect(POST(postEvent({ DB: seedDb() }))).rejects.toMatchObject({ status: 503 });
	});

	it('rejects requests without a valid cron secret', async () => {
		await expect(POST(postEvent({ CRON_SECRET, DB: seedDb() }, { secret: '' }))).rejects.toMatchObject({
			status: 401
		});
		await expect(POST(postEvent({ CRON_SECRET, DB: seedDb() }, { secret: 'wrong' }))).rejects.toMatchObject({
			status: 401
		});
	});

	it('runs the backfill with the correct secret — animated bytes correct a stale flag', async () => {
		const res = await POST(postEvent({ CRON_SECRET, DB: seedDb() }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ rasters: 1, updated: 1, unchanged: 0, lastId: 1 });
		expect(body.failed).toEqual([]);
	});

	it('leaves a correct flag unchanged for static bytes (delegation sanity)', async () => {
		const res = await POST(postEvent({ CRON_SECRET, DB: seedDb() }, { bytes: staticWebp() }));
		expect((await res.json()).unchanged).toBe(1);
	});
});
