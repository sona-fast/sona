import { describe, it, expect, beforeEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { clearSettingsCache } from '$lib/server/settings';
import { URL_COLUMNS } from '$lib/server/storage/referenced-urls';
import { POST } from './+server';

import { makeD1 } from '$lib/server/test/d1';

const CRON_SECRET = 'test-cron-secret';
const HOUR = 60 * 60 * 1000;
const CDN = 'https://cdn.example.com';

// A mock R2 bucket holding one referenced object, one old orphan (past the 48h
// gate), one day-old orphan (would pass the manual button's 1h gate but NOT the
// cron's 48h gate — pins the constant) and one fresh orphan (uploaded just now).
function makeBucket() {
	return {
		put: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({
			objects: [
				{ key: 'referenced.png', uploaded: new Date(Date.now() - 100 * HOUR) },
				{ key: 'old-orphan.png', uploaded: new Date(Date.now() - 100 * HOUR) },
				{ key: 'day-old-orphan.png', uploaded: new Date(Date.now() - 24 * HOUR) },
				{ key: 'young-orphan.png', uploaded: new Date() }
			],
			truncated: false
		}))
	};
}

function makeEnv({ seedReference = true } = {}) {
	const sqlite = new Database(':memory:');
	sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
	// Minimal URL-column-only tables, generated from the collector's source list.
	for (const { table, columns } of URL_COLUMNS) {
		const cols = getTableColumns(table) as Record<string, SQLiteColumn>;
		const ddl = columns.map((c) => `"${cols[c].name}" TEXT`).join(', ');
		sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${ddl})`);
	}
	sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run('storageProvider', 'r2');
	sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run('r2PublicUrl', CDN);
	if (seedReference) {
		sqlite
			.prepare('INSERT INTO images (image_url, thumbnail_url, source_post_url) VALUES (?, ?, ?)')
			.run(`${CDN}/referenced.png`, null, null);
	}

	const bucket = makeBucket();
	const env = { DB: makeD1(sqlite), CRON_SECRET, IMAGES: bucket };
	return { bucket, platform: { env } as unknown as App.Platform };
}

function postEvent(platform: App.Platform, { secret = CRON_SECRET, query = '' } = {}) {
	const url = new URL(`http://localhost/api/cron/cleanup-orphans${query}`);
	const request = new Request(url, {
		method: 'POST',
		headers: secret ? { authorization: `Bearer ${secret}` } : {}
	});
	return { request, url, platform } as never;
}

beforeEach(() => {
	// getSettings caches per-isolate; each test uses a fresh in-memory DB.
	clearSettingsCache();
});

describe('POST /api/cron/cleanup-orphans', () => {
	it('rejects requests without the cron secret', async () => {
		const { bucket, platform } = makeEnv();
		await expect(POST(postEvent(platform, { secret: '' }))).rejects.toMatchObject({ status: 401 });
		await expect(POST(postEvent(platform, { secret: 'wrong' }))).rejects.toMatchObject({ status: 401 });
		expect(bucket.delete).not.toHaveBeenCalled();
	});

	it('dryRun reports the count without deleting', async () => {
		const { bucket, platform } = makeEnv();
		const res = await POST(postEvent(platform, { query: '?dryRun=1' }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, wouldDelete: 1, skipped: [], errors: [] });
		expect(bucket.delete).not.toHaveBeenCalled();
	});

	it('deletes only orphans older than 48h; referenced, day-old and fresh objects survive', async () => {
		const { bucket, platform } = makeEnv();
		const res = await POST(postEvent(platform));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, deleted: 1, skipped: [], errors: [] });
		expect(bucket.delete).toHaveBeenCalledTimes(1);
		// Pins the 48h constant: the 24h-old orphan would be swept by the manual
		// button's 1h gate, but the unattended cron must leave it alone.
		expect(bucket.delete).toHaveBeenCalledWith(['old-orphan.png']);
	});

	// SAFETY BELT: if not one referenced URL resolves to a stored key (broken or
	// empty reference set — here the DB holds no URLs at all), every object would
	// be judged an orphan. The unattended cron must refuse and report, not sweep.
	it('skips a provider and reports the anomaly when no reference maps to a key', async () => {
		const { bucket, platform } = makeEnv({ seedReference: false });
		const res = await POST(postEvent(platform));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; deleted: number; skipped: string[] };
		expect(body.ok).toBe(true);
		expect(body.deleted).toBe(0);
		expect(body.skipped).toHaveLength(1);
		expect(body.skipped[0]).toMatch(/^r2:/);
		expect(bucket.delete).not.toHaveBeenCalled();
	});

	// A CONFIGURED provider failing mid-cleanup must fail the workflow run
	// (which only checks the HTTP status) — not report ok:true and stay green.
	it('returns 500 with the provider error when cleanup throws', async () => {
		const { bucket, platform } = makeEnv();
		bucket.list.mockRejectedValueOnce(new Error('R2 unavailable'));
		const res = await POST(postEvent(platform));
		expect(res.status).toBe(500);
		const body = (await res.json()) as { ok: boolean; errors: string[] };
		expect(body.ok).toBe(false);
		expect(body.errors).toEqual(['r2: R2 unavailable']);
		expect(bucket.delete).not.toHaveBeenCalled();
	});
});
