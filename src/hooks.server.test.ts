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

import { makeD1 } from '$lib/server/test/d1';

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

// Tier-A page-view capture (issue #149). A header bag with a case-insensitive get,
// so a test can hand authHandle a User-Agent / Referer / CF-IPCountry without a real
// Request (which forbids setting some of these header names).
function headers(map: Record<string, string>) {
	return { get: (k: string) => map[k.toLowerCase()] ?? null };
}

function pageviewEvent(
	pathname: string,
	db: D1Database,
	waits: Promise<unknown>[],
	hdrs: Record<string, string> = {},
	envExtra: Record<string, string> = { OBSERVABILITY_ENABLED: 'true' }
) {
	return {
		cookies: { get: () => undefined },
		url: new URL(`https://taro.surf${pathname}`),
		request: { headers: headers(hdrs) },
		locals: {} as App.Locals,
		platform: { env: { DB: db, ...envExtra }, context: { waitUntil: (p: Promise<unknown>) => waits.push(p) } }
	} as never;
}

describe('authHandle — Tier-A page-view capture (issue #149)', () => {
	beforeEach(() => {
		vi.mocked(isSetupComplete).mockResolvedValue(true);
	});

	const resolveHtml = async () =>
		new Response('<!doctype html>ok', { status: 200, headers: { 'content-type': 'text/html' } });
	const resolveXml = async () =>
		new Response('<rss/>', { status: 200, headers: { 'content-type': 'application/xml' } });

	const REAL_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148';

	it('records reduced counters for a public HTML view — referrer kept to host only', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		await authHandle({
			event: pageviewEvent('/gallery', db, waits, {
				'user-agent': REAL_UA,
				referer: 'https://t.co/xyz?utm=1&uid=personal',
				'cf-ipcountry': 'us'
			}),
			resolve: resolveHtml
		} as never);
		await Promise.all(waits);

		const rows = sqlite.prepare('SELECT metric, dim, count FROM metric_rollup ORDER BY metric, dim').all();
		expect(rows).toEqual([
			{ metric: 'country', dim: 'US', count: 1 },
			{ metric: 'device', dim: 'mobile', count: 1 },
			{ metric: 'pageview', dim: '/gallery', count: 1 },
			{ metric: 'referrer', dim: 't.co', count: 1 }, // host only — the path+query are gone
			{ metric: 'request', dim: 'public', count: 1 }
		]);
	});

	it('does NOT count admin routes or cron endpoints as page views', async () => {
		// /admin/login is admin-class but reachable (exempt from the login redirect);
		// /api/cron/* is machine-to-machine and reaches resolve. Neither is a page view.
		for (const path of ['/admin/login', '/api/cron/refresh']) {
			const { db, sqlite } = makeMetricsDb();
			const waits: Promise<unknown>[] = [];
			await authHandle({
				event: pageviewEvent(path, db, waits, { 'user-agent': REAL_UA, 'cf-ipcountry': 'US' }),
				resolve: resolveHtml
			} as never);
			await Promise.all(waits);

			expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='pageview'").get().c, path).toBe(0);
			expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='device'").get().c, path).toBe(0);
		}
	});

	it('excludes known bots at capture time and stores no user-agent string', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		await authHandle({
			event: pageviewEvent('/gallery', db, waits, {
				'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)',
				'cf-ipcountry': 'US'
			}),
			resolve: resolveHtml
		} as never);
		await Promise.all(waits);

		// The request is still counted, but NO visitor rows exist for the bot.
		expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='request'").get().c).toBe(1);
		expect(
			sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric IN ('pageview','device','referrer','country')").get().c
		).toBe(0);
		// And nothing that looks like a UA was persisted anywhere.
		const dims = sqlite.prepare('SELECT dim FROM metric_rollup').all().map((r: { dim: string }) => r.dim);
		for (const d of dims) expect(d).not.toContain('Googlebot');
	});

	it('does not count a non-HTML public response (feeds, sitemaps)', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		await authHandle({
			event: pageviewEvent('/rss.xml', db, waits, { 'user-agent': REAL_UA }),
			resolve: resolveXml
		} as never);
		await Promise.all(waits);

		expect(sqlite.prepare("SELECT COUNT(*) c FROM metric_rollup WHERE metric='pageview'").get().c).toBe(0);
	});

	it('writes NOTHING when the observability flag is off (capture dormant)', async () => {
		const { db, sqlite } = makeMetricsDb();
		const waits: Promise<unknown>[] = [];
		await authHandle({
			event: pageviewEvent('/gallery', db, waits, { 'user-agent': REAL_UA, 'cf-ipcountry': 'US' }, {}),
			resolve: resolveHtml
		} as never);
		await Promise.all(waits);

		expect(sqlite.prepare('SELECT COUNT(*) c FROM metric_rollup').get().c).toBe(0);
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

describe('authHandle — security response headers', () => {
	beforeEach(() => {
		vi.mocked(isSetupComplete).mockResolvedValue(true);
	});

	it('sets HSTS (and the existing hardening headers) on a public response', async () => {
		const db = makeDb();
		const res = (await authHandle({
			event: makeEvent('/gallery', db),
			resolve
		} as never)) as Response;

		// HSTS: one year, this host only. Neither directive is an oversight —
		// `includeSubDomains` would force HTTPS across an operator's whole personal
		// apex for a year (browser-cached, no server-side undo), and `preload` is
		// irreversible. Both are the operator's call at the edge, not ours.
		const hsts = res.headers.get('Strict-Transport-Security');
		expect(hsts).toBe('max-age=31536000');
		expect(hsts).not.toContain('includeSubDomains');
		expect(hsts).not.toContain('preload');
		expect(res.headers.get('X-Frame-Options')).toBe('DENY');
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
		// CSP is emitted by SvelteKit's kit.csp during page render, not this hook, so
		// it is asserted end-to-end in tests/e2e/csp-check.spec.ts, not here.
	});
});
