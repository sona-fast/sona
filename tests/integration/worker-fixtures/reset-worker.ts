// Worker entry for the password-reset integration harness (PR #493).
// Bundled by esbuild inside the test and run under REAL workerd via Miniflare,
// against Miniflare's real D1. The unit suite runs the reset action on a
// better-sqlite3 shim (src/lib/server/test/d1.ts), which computes meta.changes
// itself; this runs the same action where D1 computes it, because the action
// reads a revoked link off `meta.changes === 0` on its conditional upsert.
//
// Each request seeds the database, runs the real form action, and returns a JSON
// verdict: what the action did, what the upsert's D1 result reported, and what
// the tables hold afterwards.
import { isRedirect } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import { actions } from '../../../src/routes/admin/reset/+page.server';
import { getDb } from '../../../src/lib/server/db';
import { sessions } from '../../../src/lib/server/db/schema';
import { getRawSetting, setRawSetting } from '../../../src/lib/server/settings';
import { hashPassword, hashToken, verifyAdminPassword } from '../../../src/lib/server/admin-auth';
import {
	PASSWORD_RESET_SETTING,
	hashResetAddress,
	hashResetPassword
} from '../../../src/lib/server/password-reset';
import { RESET_TOKEN_COOKIE } from '../../../src/lib/config';

interface Env {
	DB: D1Database;
}

const OLD_PASSWORD = 'old-password-123';
const NEW_PASSWORD = 'brand-new-password-456';
const TOKEN = 'reset-token-under-test';

type Scenario = 'valid' | 'valid-no-existing-hash' | 'revoked-before-batch' | 'removed-before-batch';

/** Wraps the D1 binding so the test can see the raw D1 result of every batch
 * the action sends, and run a statement just before it (the race the
 * conditional write exists for). Everything else passes through, bound to the
 * real binding so workerd's native methods keep their receiver. */
function instrument(db: D1Database, beforeBatch: (() => Promise<void>) | null) {
	const batches: { changes: number; rowsWritten: number }[][] = [];
	const wrapped = new Proxy(db, {
		get(target, prop) {
			if (prop === 'batch') {
				return async (statements: Parameters<D1Database['batch']>[0]) => {
					if (beforeBatch) await beforeBatch();
					const results = await target.batch(statements);
					batches.push(
						results.map((r) => ({
							changes: r.meta.changes,
							rowsWritten: (r.meta as { rows_written?: number }).rows_written ?? -1
						}))
					);
					return results;
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return { wrapped, batches };
}

async function seed(env: Env, withExistingHash: boolean): Promise<string | null> {
	const db = getDb(env.DB);
	await env.DB.batch([
		env.DB.prepare('DELETE FROM site_settings'),
		env.DB.prepare('DELETE FROM sessions')
	]);
	const oldHash = withExistingHash ? await hashPassword(OLD_PASSWORD) : null;
	if (oldHash) await setRawSetting(db, 'adminPasswordHash', oldHash);
	await setRawSetting(db, 'adminEmail', 'admin@taro.surf');
	const expiresAt = new Date(Date.now() + 1e9).toISOString();
	await db.insert(sessions).values({ token: 'sess-a', expiresAt });
	await db.insert(sessions).values({ token: 'sess-b', expiresAt });
	await setRawSetting(
		db,
		PASSWORD_RESET_SETTING,
		JSON.stringify({
			tokenHash: await hashToken(TOKEN),
			expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
			requestedAt: new Date().toISOString(),
			emailHash: await hashResetAddress('admin@taro.surf'),
			pwHash: await hashResetPassword(oldHash)
		})
	);
	return oldHash;
}

async function run(env: Env, scenario: Scenario) {
	const oldHash = await seed(env, scenario !== 'valid-no-existing-hash');

	let beforeBatch: (() => Promise<void>) | null = null;
	if (scenario === 'revoked-before-batch') {
		// A recovery-address change rebinds the stored row: same key, new value.
		beforeBatch = async () => {
			await env.DB.prepare('UPDATE site_settings SET value = ? WHERE key = ?')
				.bind(JSON.stringify({ revoked: true }), PASSWORD_RESET_SETTING)
				.run();
		};
	} else if (scenario === 'removed-before-batch') {
		beforeBatch = async () => {
			await env.DB.prepare('DELETE FROM site_settings WHERE key = ?').bind(PASSWORD_RESET_SETTING).run();
		};
	}
	const { wrapped, batches } = instrument(env.DB, beforeBatch);

	const body = new FormData();
	body.append('password', NEW_PASSWORD);
	body.append('confirmPassword', NEW_PASSWORD);
	const cookieStore: Record<string, string> = { [RESET_TOKEN_COOKIE]: TOKEN };
	const event = {
		platform: { env: { DB: wrapped } },
		cookies: {
			get: (name: string) => cookieStore[name],
			set: (name: string, value: string) => {
				cookieStore[name] = value;
			},
			delete: (name: string) => {
				delete cookieStore[name];
			}
		},
		url: new URL('https://taro.surf/admin/reset'),
		request: new Request('https://taro.surf/admin/reset', { method: 'POST', body })
	} as never;

	let outcome: { kind: 'redirect'; status: number; location: string } | { kind: 'fail'; status: number; data: unknown };
	try {
		const result = (await actions.default(event)) as { status: number; data: unknown };
		outcome = { kind: 'fail', status: result.status, data: result.data };
	} catch (e) {
		if (!isRedirect(e)) throw e;
		outcome = { kind: 'redirect', status: e.status, location: e.location };
	}

	const db = getDb(env.DB);
	const storedHash = await getRawSetting(db, 'adminPasswordHash');
	const sessionRows = await env.DB.prepare('SELECT token FROM sessions ORDER BY token').all<{ token: string }>();
	return {
		outcome,
		batches,
		hashChanged: storedHash !== oldHash,
		storedHashPresent: storedHash !== null,
		newPasswordWorks: await verifyAdminPassword(db, undefined, NEW_PASSWORD),
		oldPasswordWorks: await verifyAdminPassword(db, undefined, OLD_PASSWORD),
		sessions: sessionRows.results.map((r) => r.token),
		resetRowPresent: (await getRawSetting(db, PASSWORD_RESET_SETTING)) !== null,
		cookieCleared: !(RESET_TOKEN_COOKIE in cookieStore)
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const scenario = new URL(request.url).searchParams.get('scenario') as Scenario;
		try {
			return new Response(JSON.stringify(await run(env, scenario)), {
				headers: { 'content-type': 'application/json' }
			});
		} catch (e) {
			// The error goes to the worker log (Miniflare prints it in the test
			// output), not the body — same rule as storage-worker.ts.
			console.error('reset-worker: scenario failed', e);
			return new Response('scenario failed', { status: 500 });
		}
	}
};
