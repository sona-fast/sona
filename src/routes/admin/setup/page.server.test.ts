import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { isRedirect } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { getRawSetting } from '$lib/server/settings';
import { DEFAULT_THEME_ID } from '$lib/themes';
import { actions } from './+page.server';

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

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
	CREATE TABLE characters (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
		is_owner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
	);`);
	const d1 = makeD1(sqlite);
	// The $app/environment stub sets dev=false, so the action walks the
	// production path: SETUP_TOKEN must exist and match the submitted token.
	const platform = { env: { DB: d1, SETUP_TOKEN: 'boot-token' } } as unknown as App.Platform;
	return { db: drizzle(d1, { schema }), platform };
}

const VALID_FIELDS = {
	setupToken: 'boot-token',
	password: 'hunter2hunter2',
	confirmPassword: 'hunter2hunter2',
	siteName: 'Taro Surf'
};

function setupEvent(platform: App.Platform, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries({ ...VALID_FIELDS, ...fields })) body.append(k, v);
	return {
		platform,
		cookies: { set: () => {} },
		request: new Request('https://taro.surf/admin/setup', { method: 'POST', body })
	} as never;
}

describe('setup wizard — unrecognized enum values fail instead of silently defaulting', () => {
	it('rejects an unknown landingLayout and saves nothing', async () => {
		const { db, platform } = makeDb();

		const result = await actions.default(setupEvent(platform, { landingLayout: 'hero' }));

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toMatch(/landing layout/i);
		expect(await getRawSetting(db, 'landingLayout')).toBeNull();
		expect(await getRawSetting(db, 'siteName')).toBeNull();
	});

	it('rejects an unknown themeId and saves nothing', async () => {
		const { db, platform } = makeDb();

		const result = await actions.default(setupEvent(platform, { themeId: 'neon' }));

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toMatch(/theme/i);
		expect(await getRawSetting(db, 'themeId')).toBeNull();
	});

	it('saves the submitted values when they are valid', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(
				setupEvent(platform, {
					themeId: 'terracotta',
					landingLayout: 'threePath',
					adminEmail: 'admin@taro.surf'
				})
			);
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
			expect(e.status).toBe(303);
		}
		expect(await getRawSetting(db, 'themeId')).toBe('terracotta');
		expect(await getRawSetting(db, 'landingLayout')).toBe('threePath');
		// The optional recovery email is persisted when provided.
		expect(await getRawSetting(db, 'adminEmail')).toBe('admin@taro.surf');
	});

	it('does not write adminEmail when the field is empty', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { adminEmail: '' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'adminEmail')).toBeNull();
	});

	it('takes the defaults when the fields are absent', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, {}));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'themeId')).toBe(DEFAULT_THEME_ID);
	});
});
