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
import { authHandle } from './hooks.server';

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
