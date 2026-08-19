// The SONA-186 regression: a D1 read failure on a cold isolate must not redirect
// a live site to /admin/setup.
//
// This file exists SEPARATELY from hooks.server.test.ts on purpose. That file
// mocks $lib/server/admin-auth at module level (a hoisted vi.mock), which makes
// the setup gate's real failure-classification unreachable there — a test that
// mocks getSetupState and feeds it 'unknown' only proves the routing switch,
// not that a broken read is classified as 'unknown' in the first place. The bug
// we shipped lived in the classification, so the test that guards it has to run
// the real thing end to end: a real drizzle query against a real (broken) D1.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { isRedirect } from '@sveltejs/kit';

import { __resetSetupCache } from '$lib/server/admin-auth';
import { authHandle } from './hooks.server';
import { makeD1 } from '$lib/server/test/d1';

// A configured site whose site_settings table is GONE — the shape a D1 outage
// takes from the app's point of view. The read throws inside drizzle, so the
// error arrives wrapped exactly as it does in production rather than as a
// hand-built stub.
function makeBrokenDb(): D1Database {
	const sqlite = new Database(':memory:');
	// Deliberately do NOT create site_settings.
	return makeD1(sqlite);
}

function makeHealthyDb(): D1Database {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		INSERT INTO site_settings (key, value) VALUES ('adminPasswordHash', 'pbkdf2$sha256$100000$c2FsdA==$aGFzaA==');`);
	return makeD1(sqlite);
}

function makeEvent(
	pathname: string,
	db: D1Database,
	env: Record<string, string> = {},
	sessionToken?: string
) {
	return {
		cookies: { get: () => sessionToken },
		url: new URL(`https://taro.surf${pathname}`),
		// The observability block reads request headers for the device class;
		// a bare Request keeps the DB-isolation spy's /gallery control honest.
		request: new Request(`https://taro.surf${pathname}`),
		locals: {} as App.Locals,
		platform: { env: { DB: db, ...env } } as unknown as App.Platform
	} as never;
}

const resolve = async () => new Response('ok', { headers: { 'content-type': 'text/html' } });

async function driveGate(
	pathname: string,
	db: D1Database,
	env: Record<string, string> = {},
	sessionToken?: string
): Promise<{ redirect: string | null; status: number; body: string }> {
	try {
		const res = (await authHandle({
			event: makeEvent(pathname, db, env, sessionToken),
			resolve
		} as never)) as Response;
		return { redirect: null, status: res.status, body: await res.text() };
	} catch (e) {
		if (isRedirect(e)) return { redirect: e.location, status: e.status, body: '' };
		throw e;
	}
}

describe('setup gate — a failed settings read is not "no admin credential"', () => {
	beforeEach(() => {
		__resetSetupCache();
		// The 'unknown' branch warns; keep the suite output clean but assert on it.
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// THE regression test. On the code that shipped the SONA-186 incident this
	// fails with redirect === '/admin/setup'.
	it('serves a public route instead of redirecting it to the setup wizard', async () => {
		const { redirect, status } = await driveGate('/gallery', makeBrokenDb());

		expect(redirect).toBeNull();
		expect(status).toBe(200);
	});

	it('does the same for the site root', async () => {
		expect((await driveGate('/', makeBrokenDb())).redirect).toBeNull();
	});

	it('keeps /admin closed rather than letting anyone reach the wizard on a blip', async () => {
		const { redirect, status, body } = await driveGate('/admin/images', makeBrokenDb());

		expect(redirect).toBeNull();
		expect(status).toBe(503);
		// 'unknown' is also what a fork whose migrations never ran looks like, so
		// the body has to point its owner somewhere.
		expect(body).toMatch(/apply the D1 migrations/i);
	});

	it('keeps /api closed', async () => {
		expect((await driveGate('/api/images', makeBrokenDb())).status).toBe(503);
	});

	// Load-bearing exemption, not an oversight. The case for letting public routes
	// serve is that the wizard's own action refuses while the state is unreadable
	// — which only holds while the wizard is still REACHABLE. A later edit that
	// blanket-503s /admin, or moves the isSetupRoute exemption below the switch,
	// would take away the operator's only diagnostic during an outage.
	it('leaves /admin/setup reachable so the operator still gets its error', async () => {
		expect((await driveGate('/admin/setup', makeBrokenDb())).status).toBe(200);
	});

	it('logs the failed read — a 200 leaves no other trace of a dead database', async () => {
		await driveGate('/gallery', makeBrokenDb());

		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining('setup-state read failed'),
			expect.anything()
		);
	});

	// The fail-closed direction still has to work where it was meant to: a site
	// that genuinely has no credential yet.
	it('still redirects to the wizard when the read SUCCEEDS and finds nothing', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

		expect((await driveGate('/gallery', makeD1(sqlite))).redirect).toBe('/admin/setup');
	});

	// SONA-171: an unclaimed fork still serves its vulnerability-reporting path
	// while everything else redirects to the wizard.
	it('exempts /.well-known/security.txt from the wizard redirect', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

		const gated = await driveGate('/.well-known/security.txt', makeD1(sqlite));
		expect(gated.redirect).toBeNull();
		expect(gated.status).toBe(200);
	});

	// The stronger promise the exemption comments make: the route performs NO
	// read from this fork's DB — not the setup gate's, and not the theme read
	// further down (its skip is try/caught, so without this spy the exemption
	// could silently regress with every other test green).
	it('never touches the database for /.well-known/security.txt', async () => {
		// Observability ON, so the metrics write path is under the spy too — the
		// route must touch the DB in NO direction, reads and counters alike.
		const observability = { OBSERVABILITY_ENABLED: 'true' };
		const db = makeHealthyDb();
		const prepare = vi.spyOn(db, 'prepare');

		await driveGate('/.well-known/security.txt', db, observability);
		expect(prepare).not.toHaveBeenCalled();

		// With a session cookie too: the session lookup runs before the gates,
		// so without its own exemption a cookie-carrying request would read the
		// sessions table (the CodeRabbit round's catch on sona#379).
		await driveGate('/.well-known/security.txt', db, observability, 'some-session-token');
		expect(prepare).not.toHaveBeenCalled();

		// Guard against a vacuous pass: the same drive on a public route does
		// hit the DB through this spy.
		await driveGate('/gallery', db, observability);
		expect(prepare).toHaveBeenCalled();
	});

	it('lets a configured site through untouched', async () => {
		expect((await driveGate('/gallery', makeHealthyDb())).redirect).toBeNull();
	});

	// Deliberate, and recorded so a later edit has to argue with a test: only
	// /admin/setup is exempt, so login is shut during an outage too. Nothing is
	// lost by that — login validates against the same unreachable database.
	it('keeps /admin/login shut, unlike /admin/setup', async () => {
		expect((await driveGate('/admin/login', makeBrokenDb())).status).toBe(503);
	});
});
