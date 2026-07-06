import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { isRedirect } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { sessions } from '$lib/server/db/schema';
import { getRawSetting, setRawSetting } from '$lib/server/settings';
import { hashPassword, hashToken, verifyAdminPassword } from '$lib/server/admin-auth';
import { PASSWORD_RESET_SETTING } from '$lib/server/password-reset';
import { actions } from './+page.server';

// Shim that also implements batch() in a transaction (all-or-nothing, like D1),
// which the reset action relies on. Same approach as sticker-import.test.ts.
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
			bind(...params: unknown[]) {
				return {
					run: () => exec(sql, params, 'run'),
					all: () => exec(sql, params, 'all'),
					raw: () => exec(sql, params, 'raw'),
					_run: () => exec(sql, params, 'run')
				};
			}
		};
	}
	async function batch(statements: Array<{ _run: () => unknown }>) {
		return sqlite.transaction((stmts: Array<{ _run: () => unknown }>) => stmts.map((s) => s._run()))(statements);
	}
	return { prepare, batch } as unknown as D1Database;
}

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL);`);
	const d1 = makeD1(sqlite);
	const platform = { env: { DB: d1 } } as unknown as App.Platform;
	return { db: drizzle(d1, { schema }), platform };
}

function resetEvent(platform: App.Platform, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	return {
		platform,
		url: new URL('https://taro.surf/admin/reset'),
		request: new Request('https://taro.surf/admin/reset', { method: 'POST', body })
	} as never;
}

const OLD_PASSWORD = 'old-password-123';
const NEW_PASSWORD = 'brand-new-password-456';
const TOKEN = 'reset-token-under-test';

/** Seed an old admin password, two live sessions, and a stored reset row. */
async function seed(db: ReturnType<typeof makeDb>['db'], tokenExpiresInMs: number) {
	await setRawSetting(db, 'adminPasswordHash', await hashPassword(OLD_PASSWORD));
	await db.insert(sessions).values({ token: 'sess-a', expiresAt: new Date(Date.now() + 1e9).toISOString() });
	await db.insert(sessions).values({ token: 'sess-b', expiresAt: new Date(Date.now() + 1e9).toISOString() });
	await setRawSetting(
		db,
		PASSWORD_RESET_SETTING,
		JSON.stringify({
			tokenHash: await hashToken(TOKEN),
			expiresAt: new Date(Date.now() + tokenExpiresInMs).toISOString(),
			requestedAt: new Date().toISOString()
		})
	);
}

describe('reset action', () => {
	it('sets the new password, clears every session, and consumes the token', async () => {
		const { db, platform } = makeDb();
		await seed(db, 30 * 60 * 1000);

		try {
			await actions.default(resetEvent(platform, { token: TOKEN, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }));
			expect.unreachable('reset should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
			expect(e.status).toBe(303);
			expect(e.location).toBe('/admin/login?reset=1');
		}

		expect(await verifyAdminPassword(db, undefined, NEW_PASSWORD)).toBe(true);
		expect(await verifyAdminPassword(db, undefined, OLD_PASSWORD)).toBe(false);
		// Every admin session revoked.
		expect(await db.select().from(sessions)).toHaveLength(0);
		// Token single-use: the row is gone.
		expect(await getRawSetting(db, PASSWORD_RESET_SETTING)).toBeNull();
	});

	it('rejects an expired token and leaves the password unchanged', async () => {
		const { db, platform } = makeDb();
		await seed(db, -1000); // already expired

		const result = await actions.default(
			resetEvent(platform, { token: TOKEN, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
		);

		expect(result).toMatchObject({ status: 400, data: { invalidToken: true } });
		expect(await verifyAdminPassword(db, undefined, OLD_PASSWORD)).toBe(true);
		expect(await db.select().from(sessions)).toHaveLength(2);
	});

	it('rejects a wrong token', async () => {
		const { db, platform } = makeDb();
		await seed(db, 30 * 60 * 1000);

		const result = await actions.default(
			resetEvent(platform, { token: 'not-the-token', password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
		);

		expect(result).toMatchObject({ status: 400, data: { invalidToken: true } });
		expect(await verifyAdminPassword(db, undefined, OLD_PASSWORD)).toBe(true);
	});

	it('rejects a too-short password with a valid token (same rule as the wizard)', async () => {
		const { db, platform } = makeDb();
		await seed(db, 30 * 60 * 1000);

		const result = await actions.default(
			resetEvent(platform, { token: TOKEN, password: 'short', confirmPassword: 'short' })
		);

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { invalidToken?: boolean } }).data.invalidToken).toBeUndefined();
		expect(await verifyAdminPassword(db, undefined, OLD_PASSWORD)).toBe(true);
	});

	it('rejects reuse of a token after a successful reset', async () => {
		const { db, platform } = makeDb();
		await seed(db, 30 * 60 * 1000);

		try {
			await actions.default(resetEvent(platform, { token: TOKEN, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }));
			expect.unreachable('first reset should redirect');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}

		// Second attempt with the same (now consumed) token fails.
		const result = await actions.default(
			resetEvent(platform, { token: TOKEN, password: 'another-password-789', confirmPassword: 'another-password-789' })
		);
		expect(result).toMatchObject({ status: 400, data: { invalidToken: true } });
		expect(await verifyAdminPassword(db, undefined, NEW_PASSWORD)).toBe(true);
	});
});
