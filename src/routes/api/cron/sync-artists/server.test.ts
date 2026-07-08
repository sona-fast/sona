import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';
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

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE artists (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
		global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
		aliases TEXT, created_at TEXT NOT NULL
	);
	CREATE TABLE job_run (name TEXT PRIMARY KEY, status TEXT NOT NULL, ran_at TEXT NOT NULL, detail TEXT);`);
	const d1 = makeD1(sqlite);
	// Capture the fire-and-forget observability writes (recordJobRun) so a test can
	// await them before asserting the heartbeat row.
	const waits: Promise<unknown>[] = [];
	return {
		sqlite,
		waits,
		db: drizzle(d1, { schema }),
		platform: {
			env: { DB: d1, CRON_SECRET },
			context: { waitUntil: (p: Promise<unknown>) => waits.push(p) }
		} as unknown as App.Platform
	};
}

function postEvent(platform: App.Platform) {
	const request = new Request('http://localhost/api/cron/sync-artists', {
		method: 'POST',
		headers: { authorization: `Bearer ${CRON_SECRET}` }
	});
	return { request, platform } as never;
}

// The registry itself must never be hit from tests: fail every fetch so the
// client's graceful-degradation fallbacks (empty delta feed) apply.
beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('POST /api/cron/sync-artists — registry enablement gate', () => {
	it('passes the gate with a D1-stored fork key and no env secret', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });

		const res = await POST(postEvent(platform));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; skipped?: boolean };
		expect(body.ok).toBe(true);
		expect(body.skipped).toBeUndefined();
	});

	it('503s when nothing is stored and no env secret exists', async () => {
		const { platform } = makeDb();

		await expect(POST(postEvent(platform))).rejects.toMatchObject({ status: 503 });
	});
});

describe('POST /api/cron/sync-artists — observability heartbeat (issue #6)', () => {
	it('records a job_run "ok" row on a successful run', async () => {
		const { db, platform, waits, sqlite } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });

		const res = await POST(postEvent(platform));
		expect(res.status).toBe(200);
		// The heartbeat write is scheduled fire-and-forget; drain it before asserting.
		await Promise.all(waits);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const row = (sqlite as any).prepare("SELECT status FROM job_run WHERE name='sync-artists'").get();
		expect(row?.status).toBe('ok');
	});
});
