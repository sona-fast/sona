import { describe, it, expect, beforeEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { D1Database } from '@cloudflare/workers-types';
import { clearSettingsCache } from '$lib/server/settings';
import { URL_COLUMNS } from '$lib/server/storage/referenced-urls';
import { POST } from './+server';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses
// (client.prepare().bind().run()/all()), same approach as sticker-import.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: any): D1Database {
	function exec(sql: string, params: unknown[], mode: 'run' | 'all' | 'raw') {
		const stmt = sqlite.prepare(sql);
		if (mode === 'raw') {
			try {
				return stmt.raw(true).all(...params) as unknown[];
			} finally {
				stmt.raw(false);
			}
		}
		if (stmt.reader) return { results: stmt.all(...params), success: true, meta: {} };
		const info = stmt.run(...params);
		return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
	}
	function prepare(sql: string) {
		return {
			bind: (...params: unknown[]) => ({
				run: () => exec(sql, params, 'run'),
				all: () => exec(sql, params, 'all'),
				raw: () => exec(sql, params, 'raw')
			})
		};
	}
	return { prepare } as unknown as D1Database;
}

const CRON_SECRET = 'test-cron-secret';
const HOUR = 60 * 60 * 1000;
const CDN = 'https://cdn.example.com';

// A mock R2 bucket holding one referenced object, one old orphan (past the 48h
// gate) and one fresh orphan (uploaded just now — must be protected).
function makeBucket() {
	return {
		put: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({
			objects: [
				{ key: 'referenced.png', uploaded: new Date(Date.now() - 100 * HOUR) },
				{ key: 'old-orphan.png', uploaded: new Date(Date.now() - 100 * HOUR) },
				{ key: 'young-orphan.png', uploaded: new Date() }
			],
			truncated: false
		}))
	};
}

function makeEnv() {
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
	sqlite
		.prepare('INSERT INTO images (image_url, thumbnail_url, source_post_url) VALUES (?, ?, ?)')
		.run(`${CDN}/referenced.png`, null, null);

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
		expect(await res.json()).toEqual({ ok: true, wouldDelete: 1 });
		expect(bucket.delete).not.toHaveBeenCalled();
	});

	it('deletes only orphans older than 48h; referenced and fresh objects survive', async () => {
		const { bucket, platform } = makeEnv();
		const res = await POST(postEvent(platform));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, deleted: 1 });
		expect(bucket.delete).toHaveBeenCalledTimes(1);
		expect(bucket.delete).toHaveBeenCalledWith(['old-orphan.png']);
	});
});
