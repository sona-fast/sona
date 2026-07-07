import { describe, it, expect, vi, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { getDb } from './db';
import { getObservability, getCloudflareEdge, deriveVerdict, type JobStatus, type StorageHealth } from './observability';
import { dayKey } from './metrics';
import type { SiteSettings } from './settings';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSqlite(): any {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE metric_rollup (day TEXT NOT NULL, metric TEXT NOT NULL, dim TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric, dim));
		CREATE TABLE error_sample (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, message TEXT NOT NULL);
		CREATE TABLE job_run (name TEXT PRIMARY KEY, status TEXT NOT NULL, ran_at TEXT NOT NULL, detail TEXT);
	`);
	return sqlite;
}

function daysAgo(n: number): string {
	return dayKey(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
}

const SETTINGS_R2 = { storageProvider: 'r2' } as SiteSettings;

describe('getObservability — aggregation over the 7-day window', () => {
	it('sums requests/errors/uploads/emails and excludes rows older than the window', async () => {
		const sqlite = makeSqlite();
		const seed = sqlite.prepare('INSERT INTO metric_rollup (day, metric, dim, count) VALUES (?, ?, ?, ?)');
		seed.run(daysAgo(0), 'request', 'public', 100);
		seed.run(daysAgo(3), 'request', 'public', 50);
		seed.run(daysAgo(10), 'request', 'public', 999); // outside 7d — must be excluded
		seed.run(daysAgo(0), 'error', '500', 2);
		seed.run(daysAgo(0), 'upload', 'ok', 10);
		seed.run(daysAgo(0), 'upload', 'fail', 1);
		seed.run(daysAgo(0), 'email', 'sent', 5);
		seed.run(daysAgo(0), 'email', 'failed', 1);

		const db = getDb(makeD1(sqlite));
		const o = await getObservability(db, SETTINGS_R2, undefined);

		expect(o.appRequests).toBe(150);
		expect(o.errors5xx).toBe(2);
		expect(o.errorRate).toBeCloseTo(2 / 150);
		expect(o.uploads).toEqual({ ok: 10, fail: 1 });
		expect(o.emails).toEqual({ sent: 5, failed: 1 });
		// Sparkline spans exactly the window, newest last, gaps zero-filled.
		expect(o.sparkline).toHaveLength(o.windowDays);
		expect(o.sparkline[o.windowDays - 1]).toBe(100);
		expect(o.sparkline.reduce((a, b) => a + b, 0)).toBe(150);
	});

	it('reports a zero error rate when there is no traffic (no divide-by-zero)', async () => {
		const db = getDb(makeD1(makeSqlite()));
		const o = await getObservability(db, SETTINGS_R2, undefined);
		expect(o.appRequests).toBe(0);
		expect(o.errorRate).toBe(0);
		expect(o.verdict.level).toBe('ok');
	});
});

describe('getObservability — provider health', () => {
	it('labels storage by the active provider and surfaces the last upload/email failure', async () => {
		const sqlite = makeSqlite();
		const seedM = sqlite.prepare('INSERT INTO metric_rollup (day, metric, dim, count) VALUES (?, ?, ?, ?)');
		seedM.run(daysAgo(0), 'upload', 'ok', 8);
		seedM.run(daysAgo(0), 'upload', 'fail', 2);
		seedM.run(daysAgo(0), 'email', 'sent', 3);
		const seedE = sqlite.prepare('INSERT INTO error_sample (ts, route, status, message) VALUES (?, ?, ?, ?)');
		seedE.run(new Date().toISOString(), '/admin/images', 500, 'D1_ERROR');
		seedE.run(new Date().toISOString(), 'upload', 413, 'file too large');
		seedE.run(new Date().toISOString(), 'email', 422, 'invalid from domain');

		const db = getDb(makeD1(sqlite));
		// env has R2 bound + a Resend key → both providers report configured.
		const env = { IMAGES: {}, RESEND_API_KEY: 'x' } as unknown as App.Platform['env'];
		const o = await getObservability(db, SETTINGS_R2, env);

		expect(o.providers.storage.label).toBe('Cloudflare R2');
		expect(o.providers.storage.configured).toBe(true);
		expect(o.providers.storage.uploads).toBe(10);
		expect(o.providers.storage.failed).toBe(2);
		expect(o.providers.storage.failRate).toBeCloseTo(0.2);
		expect(o.providers.storage.lastFailure?.message).toBe('file too large');

		expect(o.providers.email.configured).toBe(true);
		expect(o.providers.email.sent).toBe(3);
		expect(o.providers.email.lastFailure?.message).toBe('invalid from domain');
	});

	it('labels storage as UploadThing and marks it not configured when the token is absent', async () => {
		const db = getDb(makeD1(makeSqlite()));
		const o = await getObservability(db, { storageProvider: 'uploadthing' } as SiteSettings, undefined);
		expect(o.providers.storage.label).toBe('UploadThing');
		expect(o.providers.storage.configured).toBe(false);
		expect(o.providers.email.configured).toBe(false);
	});
});

describe('getObservability — background jobs', () => {
	it('maps the known crons and shows null status for one that never ran', async () => {
		const sqlite = makeSqlite();
		const seed = sqlite.prepare('INSERT INTO job_run (name, status, ran_at, detail) VALUES (?, ?, ?, ?)');
		seed.run('resync-telegram', 'ok', new Date().toISOString(), 'imported 0');
		seed.run('cleanup-orphans', 'failed', new Date().toISOString(), 'R2 error');
		// sync-artists intentionally never ran.

		const db = getDb(makeD1(sqlite));
		const o = await getObservability(db, SETTINGS_R2, undefined);
		const byName = Object.fromEntries(o.jobs.map((j) => [j.name, j]));
		expect(byName['resync-telegram'].status).toBe('ok');
		expect(byName['cleanup-orphans'].status).toBe('failed');
		expect(byName['sync-artists'].status).toBe(null);
		// A failed job drives the verdict to "needs attention".
		expect(o.verdict.level).toBe('warn');
	});
});

describe('getCloudflareEdge — optional, graceful', () => {
	// All three secrets present → the query runs and we control fetch.
	const CF_ENV = {
		CF_ANALYTICS_TOKEN: 'token',
		CF_ZONE_ID: 'zone',
		CF_ACCOUNT_ID: 'acct'
	} as unknown as App.Platform['env'];

	// Minimal Response-like the code path uses (resp.ok, resp.status, resp.json()).
	function stubFetchJson(body: unknown, init: { ok?: boolean; status?: number } = {}) {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: init.ok ?? true,
				status: init.status ?? 200,
				json: async () => body
			})
		);
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns not-configured when the secrets are absent', async () => {
		expect(await getCloudflareEdge(undefined)).toEqual({ state: 'not-configured' });
		const partial = { CF_ANALYTICS_TOKEN: 'x' } as unknown as App.Platform['env'];
		expect(await getCloudflareEdge(partial)).toEqual({ state: 'not-configured' });
	});

	it('connects: sums a multi-group payload and derives the cache-hit rate', async () => {
		stubFetchJson({
			data: {
				viewer: {
					zones: [
						{
							httpRequests1dGroups: [
								{ sum: { requests: 100, cachedRequests: 60, bytes: 1000, threats: 2 } },
								{ sum: { requests: 50, cachedRequests: 40, bytes: 500, threats: 1 } }
							]
						}
					]
				}
			}
		});

		const cf = await getCloudflareEdge(CF_ENV);
		expect(cf).toEqual({
			state: 'connected',
			requests: 150,
			cachedRequests: 100,
			cacheHitRate: 100 / 150,
			bytes: 1500,
			threats: 3
		});
	});

	it('connects with a zero cache-hit rate when there were zero requests (no divide-by-zero)', async () => {
		stubFetchJson({
			data: {
				viewer: {
					zones: [{ httpRequests1dGroups: [{ sum: { requests: 0, cachedRequests: 0, bytes: 0, threats: 0 } }] }]
				}
			}
		});

		const cf = await getCloudflareEdge(CF_ENV);
		expect(cf).toMatchObject({ state: 'connected', requests: 0, cacheHitRate: 0 });
	});

	it('errors when the HTTP response is not ok (e.g. a mis-scoped 403 token)', async () => {
		stubFetchJson({}, { ok: false, status: 403 });
		const cf = await getCloudflareEdge(CF_ENV);
		expect(cf.state).toBe('error');
		if (cf.state === 'error') expect(cf.message).toContain('403');
	});

	it('errors when the GraphQL body carries an errors[] array', async () => {
		stubFetchJson({ errors: [{ message: 'Invalid token' }] });
		const cf = await getCloudflareEdge(CF_ENV);
		expect(cf).toEqual({ state: 'error', message: 'Invalid token' });
	});

	it('errors when no zone groups come back (bare pages.dev / no zone)', async () => {
		stubFetchJson({ data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } } });
		const cf = await getCloudflareEdge(CF_ENV);
		expect(cf.state).toBe('error');
		if (cf.state === 'error') expect(cf.message).toMatch(/no traffic|custom domain|zone/i);
	});

	it('errors (never throws) when fetch itself rejects', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
		const cf = await getCloudflareEdge(CF_ENV);
		expect(cf).toEqual({ state: 'error', message: 'network down' });
	});
});

describe('deriveVerdict', () => {
	const jobs = (status: JobStatus['status']): JobStatus[] => [
		{ name: 'cleanup-orphans', label: 'Orphan cleanup', status, ranAt: null, detail: null }
	];
	const cleanStorage: StorageHealth = {
		label: 'Cloudflare R2', configured: true, uploads: 0, failed: 0, failRate: 0, lastFailure: null
	};

	it('is ok when nothing is wrong', () => {
		expect(deriveVerdict({ errorRate: 0.001, jobs: jobs('ok'), storage: cleanStorage }).level).toBe('ok');
	});

	it('warns on a failed job even with a low error rate', () => {
		expect(deriveVerdict({ errorRate: 0, jobs: jobs('failed'), storage: cleanStorage }).level).toBe('warn');
	});

	it('goes down when the error rate is very high (worst signal wins over a failed job)', () => {
		expect(deriveVerdict({ errorRate: 0.2, jobs: jobs('failed'), storage: cleanStorage }).level).toBe('down');
	});
});
