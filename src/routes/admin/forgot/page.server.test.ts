import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { getRawSetting, setRawSetting } from '$lib/server/settings';
import { PASSWORD_RESET_SETTING } from '$lib/server/password-reset';
import { actions } from './+page.server';

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

function makeDb(env: Record<string, unknown> = {}) {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	const d1 = makeD1(sqlite);
	const platform = { env: { DB: d1, ...env } } as unknown as App.Platform;
	return { db: drizzle(d1, { schema }), platform };
}

function forgotEvent(platform: App.Platform, email: string) {
	const body = new FormData();
	body.append('email', email);
	return {
		platform,
		url: new URL('https://taro.surf/admin/forgot'),
		request: new Request('https://taro.surf/admin/forgot', { method: 'POST', body })
	} as never;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function sentEmail(): { from: string; to: string; subject: string; html: string; text: string } {
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	expect(String(url)).toBe('https://api.resend.com/emails');
	return JSON.parse(init.body as string);
}

describe('forgot action', () => {
	it('mints a hashed token and sends the reset email when the email matches', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		await db.insert(siteSettings).values({ key: 'siteName', value: 'Taro Surf' });

		// Case-insensitive match still succeeds.
		const result = await actions.default(forgotEvent(platform, 'Admin@Taro.Surf'));

		expect(result).toEqual({ sent: true });
		const row = await getRawSetting(db, PASSWORD_RESET_SETTING);
		expect(row).toBeTruthy();
		const stored = JSON.parse(row!);
		// Only the hash is stored — never a raw token.
		expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(typeof stored.expiresAt).toBe('string');

		const email = sentEmail();
		expect(email.to).toBe('admin@taro.surf');
		expect(email.subject).toContain('Taro Surf');
		expect(email.text).toMatch(/https:\/\/taro\.surf\/admin\/reset\?token=/);
		// From identifies the fork (its siteName), not Sona, when RESEND_FROM is unset.
		expect(email.from).toBe('Taro Surf <onboarding@resend.dev>');
		// An HTML body ships alongside the text, carrying the fork identity + reset link.
		expect(email.html).toContain('Taro Surf');
		expect(email.html).toMatch(/https:\/\/taro\.surf\/admin\/reset\?token=/);
	});

	it('returns the same generic response and does nothing when the email does not match', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });

		const result = await actions.default(forgotEvent(platform, 'someone-else@example.com'));

		expect(result).toEqual({ sent: true });
		expect(await getRawSetting(db, PASSWORD_RESET_SETTING)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('no-ops (but still generic) when RESEND_API_KEY is unset', async () => {
		const { db, platform } = makeDb(); // no RESEND_API_KEY
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });

		const result = await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		expect(result).toEqual({ sent: true });
		expect(await getRawSetting(db, PASSWORD_RESET_SETTING)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('skips the send within the 2-minute cooldown, keeping the existing token', async () => {
		const { db, platform } = makeDb({ RESEND_API_KEY: 'rk_test' });
		await db.insert(siteSettings).values({ key: 'adminEmail', value: 'admin@taro.surf' });
		// A fresh existing request (30s ago) should suppress a resend.
		const existing = JSON.stringify({
			tokenHash: 'a'.repeat(64),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			requestedAt: new Date(Date.now() - 30_000).toISOString()
		});
		await setRawSetting(db, PASSWORD_RESET_SETTING, existing);

		const result = await actions.default(forgotEvent(platform, 'admin@taro.surf'));

		expect(result).toEqual({ sent: true });
		expect(fetchMock).not.toHaveBeenCalled();
		// The existing token row is left intact (link the operator may be following).
		expect(await getRawSetting(db, PASSWORD_RESET_SETTING)).toBe(existing);
	});
});
