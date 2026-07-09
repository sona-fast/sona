import { describe, it, expect, beforeEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { isRedirect } from '@sveltejs/kit';

// Control the setup gate without touching D1. hashToken is also imported by the
// hook (unused here — no session cookie), so keep the rest of the module real.
vi.mock('$lib/server/admin-auth', async (orig) => ({
	...(await orig<typeof import('$lib/server/admin-auth')>()),
	isSetupComplete: vi.fn()
}));

import { isSetupComplete } from '$lib/server/admin-auth';
import { authHandle, handleError } from './hooks.server';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses.
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

function makeDb(): D1Database {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	return makeD1(sqlite);
}

// No session cookie — cookies.get returns undefined for every key, so the request
// is unauthenticated (locals.admin = false).
function makeEvent(pathname: string, db: D1Database) {
	return {
		cookies: { get: () => undefined },
		url: new URL(`https://taro.surf${pathname}`),
		locals: {} as App.Locals,
		platform: { env: { DB: db } } as unknown as App.Platform
	} as never;
}

const resolve = async () =>
	new Response('ok', { headers: { 'content-type': 'text/html' } });

async function redirectFor(pathname: string, db: D1Database): Promise<{ status: number; location: string } | null> {
	try {
		await authHandle({ event: makeEvent(pathname, db), resolve } as never);
		return null;
	} catch (e) {
		if (isRedirect(e)) return { status: e.status, location: e.location };
		throw e;
	}
}

describe('authHandle — password-recovery route exemption', () => {
	beforeEach(() => {
		vi.mocked(isSetupComplete).mockReset();
	});

	it('lets /admin/forgot and /admin/reset through without a login redirect', async () => {
		vi.mocked(isSetupComplete).mockResolvedValue(true);
		const db = makeDb();

		expect(await redirectFor('/admin/forgot', db)).toBeNull();
		expect(await redirectFor('/admin/reset', db)).toBeNull();
	});

	it('still redirects other admin routes to /admin/login without a session', async () => {
		vi.mocked(isSetupComplete).mockResolvedValue(true);
		const db = makeDb();

		expect(await redirectFor('/admin/images', db)).toEqual({ status: 302, location: '/admin/login' });
		expect(await redirectFor('/admin/settings', db)).toEqual({ status: 302, location: '/admin/login' });
		// Observability (issue #6) is a normal admin route — no session, no access.
		expect(await redirectFor('/admin/observability', db)).toEqual({ status: 302, location: '/admin/login' });
	});

	it('sends /admin/forgot to /admin/setup when setup is incomplete (setup gate wins)', async () => {
		vi.mocked(isSetupComplete).mockResolvedValue(false);
		const db = makeDb();

		expect(await redirectFor('/admin/forgot', db)).toEqual({ status: 302, location: '/admin/setup' });
	});
});

describe('authHandle — /api/admin/ref-image stays behind the admin gate', () => {
	it('returns 401 without a session (not in the /api/cron/ exempt namespace)', async () => {
		vi.mocked(isSetupComplete).mockResolvedValue(true);
		const db = makeDb();

		const res = (await authHandle({
			event: makeEvent('/api/admin/ref-image?id=1', db),
			resolve
		} as never)) as Response;

		expect(res.status).toBe(401);
	});
});

describe('authHandle — /api/metrics/download is the only other public /api route', () => {
	it('reaches the endpoint without a session (an anonymous visitor pressed download)', async () => {
		vi.mocked(isSetupComplete).mockResolvedValue(true);

		const res = (await authHandle({
			event: makeEvent('/api/metrics/download', makeDb()),
			resolve
		} as never)) as Response;

		// Not 401: the gate let it through to the endpoint, which does its own
		// same-origin check. Anything but 401 proves the exemption is wired.
		expect(res.status).not.toBe(401);
	});

	it('does not exempt sibling paths — a prefix match would open the whole namespace', async () => {
		vi.mocked(isSetupComplete).mockResolvedValue(true);

		for (const path of ['/api/metrics', '/api/metrics/download/extra', '/api/metrics/other']) {
			const res = (await authHandle({
				event: makeEvent(path, makeDb()),
				resolve
			} as never)) as Response;
			expect(res.status, `${path} must stay behind the admin gate`).toBe(401);
		}
	});
});

// Observability 5xx accounting (issue #6). A metrics-capable DB plus a waitUntil
// that captures the fire-and-forget writes so a test can await them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMetricsDb(): { db: D1Database; sqlite: any } {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const sqlite = new Database(':memory:') as any;
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE metric_rollup (day TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric, dim));
		CREATE TABLE error_sample (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, message TEXT NOT NULL);
		CREATE TABLE job_run (name TEXT PRIMARY KEY, status TEXT NOT NULL, ran_at TEXT NOT NULL, detail TEXT);
	`);
	return { db: makeD1(sqlite), sqlite };
}

// envExtra defaults to the enabled flag so the existing 5xx-accounting tests
// exercise the write path; the off-flag test passes {} to leave it disabled.
function metricsEvent(
	pathname: string,
	db: D1Database,
	waits: Promise<unknown>[],
	locals: App.Locals = {},
	envExtra: Record<string, string> = { OBSERVABILITY_ENABLED: 'true' }
) {
	return {
		cookies: { get: () => undefined },
		url: new URL(`https://taro.surf${pathname}`),
		locals,
		platform: { env: { DB: db, ...envExtra }, context: { waitUntil: (p: Promise<unknown>) => waits.push(p) } }
	} as never;
}

describe('handleError — rich 5xx sample (issue #6)', () => {
	it('records ONE detailed error sample (no rollup) and flags the event for a 5xx', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const locals = {} as App.Locals;
		const event = {
			url: new URL('https://taro.surf/admin/images'),
			locals,
			platform: { env: { DB: db, OBSERVABILITY_ENABLED: 'true' }, context: { waitUntil: (p: Promise<unknown>) => waits.push(p) } }
		} as never;

		handleError({ error: new Error('D1_ERROR: boom'), event, status: 500, message: 'Internal Error' } as never);
		await Promise.all(waits);

		// The detailed row carries the real message; the RATE rollup is authHandle's job.
		const samples = sqlite.prepare('SELECT route, status, message FROM error_sample').all();
		expect(samples).toEqual([{ route: '/admin/images', status: 500, message: 'D1_ERROR: boom' }]);
		expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='error'").get().c).toBe(0);
		// The flag tells authHandle to skip its generic fallback sample for this 5xx.
		expect(locals.errorSampled).toBe(true);
	});

	it('does nothing for a sub-500 status', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		const locals = {} as App.Locals;
		const event = {
			url: new URL('https://taro.surf/gallery'),
			locals,
			platform: { env: { DB: db }, context: { waitUntil: (p: Promise<unknown>) => waits.push(p) } }
		} as never;

		handleError({ error: new Error('not found'), event, status: 404, message: 'Not Found' } as never);
		await Promise.all(waits);

		expect(sqlite.prepare('SELECT COUNT(*) c FROM error_sample').get().c).toBe(0);
		expect(locals.errorSampled).toBeUndefined();
	});
});

describe('authHandle — 5xx counts toward the error rate (issue #6)', () => {
	beforeEach(() => {
		vi.mocked(isSetupComplete).mockResolvedValue(true);
	});

	const resolve500 = async () =>
		new Response('err', { status: 500, headers: { 'content-type': 'text/html' } });

	it('counts a request + error rollup and drops a generic sample for a deliberate 5xx', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		// errorSampled unset: this 5xx never reached handleError (a deliberate error(500)).
		await authHandle({ event: metricsEvent('/gallery', db, waits), resolve: resolve500 } as never);
		await Promise.all(waits);

		expect(sqlite.prepare("SELECT SUM(count) c FROM metric_rollup WHERE metric='request'").get().c).toBe(1);
		expect(sqlite.prepare("SELECT SUM(count) c FROM metric_rollup WHERE metric='error'").get().c).toBe(1);
		const samples = sqlite.prepare('SELECT route, status, message FROM error_sample').all();
		expect(samples).toEqual([{ route: '/gallery', status: 500, message: 'HTTP 500' }]);
	});

	it('skips the generic sample when handleError already sampled this 5xx (no duplicate row)', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		// errorSampled preset: a thrown exception already logged the detailed row.
		await authHandle({ event: metricsEvent('/gallery', db, waits, { errorSampled: true }), resolve: resolve500 } as never);
		await Promise.all(waits);

		// Rollup still lands exactly once (rate stays correct)...
		expect(sqlite.prepare("SELECT SUM(count) c FROM metric_rollup WHERE metric='error'").get().c).toBe(1);
		// ...but no generic fallback sample is added on top of the detailed one.
		expect(sqlite.prepare('SELECT COUNT(*) c FROM error_sample').get().c).toBe(0);
	});

	it('writes NOTHING when the observability flag is off (feature dormant)', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		// Empty envExtra => OBSERVABILITY_ENABLED unset => feature disabled.
		await authHandle({ event: metricsEvent('/gallery', db, waits, {}, {}), resolve: resolve500 } as never);
		await Promise.all(waits);

		// No request/error rollups and no error samples: the same 5xx that writes
		// rows when enabled must leave both tables empty when the flag is off.
		expect(sqlite.prepare('SELECT COUNT(*) c FROM metric_rollup').get().c).toBe(0);
		expect(sqlite.prepare('SELECT COUNT(*) c FROM error_sample').get().c).toBe(0);
	});
});
