import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { clearSettingsCache } from '$lib/server/settings';
import { load } from './+page.server';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses,
// same approach as art/page.server.test.ts.
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
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

beforeEach(() => clearSettingsCache());

describe('share load — content-presence gate (#42)', () => {
	it('404s when neither contact email nor Telegram is configured', async () => {
		const { platform } = makeDb();
		await expect(load({ platform } as never)).rejects.toMatchObject({ status: 404 });
	});

	it('loads with only a contact email', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'contactEmail', value: 'hi@example.ink' });
		await expect(load({ platform } as never)).resolves.toEqual({});
	});

	it('loads with only a Telegram URL', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'telegramUrl', value: 'https://t.me/example' });
		await expect(load({ platform } as never)).resolves.toEqual({});
	});

	it('loads with both configured', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values([
			{ key: 'contactEmail', value: 'hi@example.ink' },
			{ key: 'telegramUrl', value: 'https://t.me/example' }
		]);
		await expect(load({ platform } as never)).resolves.toEqual({});
	});
});
