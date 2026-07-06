import { describe, it, expect, beforeEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { D1Database } from '@cloudflare/workers-types';
import { clearSettingsCache } from '$lib/server/settings';
import { URL_COLUMNS } from '$lib/server/storage/referenced-urls';
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

const CDN = 'https://cdn.example.com';
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
	// getSettings caches per-isolate; each test uses a fresh in-memory DB.
	clearSettingsCache();
});

// REGRESSION: clearCache once computed "referenced" as only images.imageUrl and
// then treated the ENTIRE bucket as candidates — pressing the button would have
// deleted every sticker file+thumbnail, image thumbnail, avatar and cover as an
// "orphan". This seeds all of those and asserts only a true orphan is deleted.
describe('settings clearCache action', () => {
	it('deletes ONLY true orphans — stickers, thumbnails, avatars, covers and settings avatar survive', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
		// Minimal URL-column-only tables, generated from the collector's source list.
		for (const { table, columns } of URL_COLUMNS) {
			const cols = getTableColumns(table) as Record<string, SQLiteColumn>;
			const ddl = columns.map((c) => `"${cols[c].name}" TEXT`).join(', ');
			sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${ddl})`);
		}
		const seedSetting = sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)');
		seedSetting.run('storageProvider', 'r2');
		seedSetting.run('r2PublicUrl', CDN);
		seedSetting.run('adminAvatarUrl', `${CDN}/avatars/admin.png`);
		sqlite
			.prepare('INSERT INTO images (image_url, thumbnail_url, source_post_url) VALUES (?, ?, ?)')
			.run(`${CDN}/img.png`, `${CDN}/img.thumb.webp`, null);
		sqlite
			.prepare('INSERT INTO stickers (image_url, thumbnail_url) VALUES (?, ?)')
			.run(`${CDN}/stickers/s1.webp`, `${CDN}/stickers/s1.thumb.webp`);
		sqlite.prepare('INSERT INTO artists (avatar_url) VALUES (?)').run(`${CDN}/avatars/a1.png`);
		sqlite.prepare('INSERT INTO collections (cover_image_url) VALUES (?)').run(`${CDN}/covers/c1.png`);

		// The bucket holds every referenced object plus one true orphan (old
		// enough to pass the 1h gate) and one fresh orphan (an in-flight upload —
		// must be protected by the gate).
		const old = new Date(Date.now() - 10 * HOUR);
		const bucket = {
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {}),
			list: vi.fn(async () => ({
				objects: [
					{ key: 'img.png', uploaded: old },
					{ key: 'img.thumb.webp', uploaded: old },
					{ key: 'stickers/s1.webp', uploaded: old },
					{ key: 'stickers/s1.thumb.webp', uploaded: old },
					{ key: 'avatars/a1.png', uploaded: old },
					{ key: 'avatars/admin.png', uploaded: old },
					{ key: 'covers/c1.png', uploaded: old },
					{ key: 'true-orphan.png', uploaded: old },
					{ key: 'in-flight-upload.png', uploaded: new Date() }
				],
				truncated: false
			}))
		};
		const platform = { env: { DB: makeD1(sqlite), IMAGES: bucket } } as unknown as App.Platform;

		const result = await actions.clearCache({ platform } as never);

		expect(result).toEqual({ success: true, message: 'Deleted 1 orphaned file.' });
		expect(bucket.delete).toHaveBeenCalledTimes(1);
		expect(bucket.delete).toHaveBeenCalledWith(['true-orphan.png']);
	});

	// REGRESSION: a configured provider failing mid-cleanup used to be swallowed
	// as "not configured" — the admin was told success while nothing was cleaned.
	it('surfaces a provider failure as fail(500) instead of a false success', async () => {
		const sqlite = new Database(':memory:');
		sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
		for (const { table, columns } of URL_COLUMNS) {
			const cols = getTableColumns(table) as Record<string, SQLiteColumn>;
			const ddl = columns.map((c) => `"${cols[c].name}" TEXT`).join(', ');
			sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${ddl})`);
		}
		const seedSetting = sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)');
		seedSetting.run('storageProvider', 'r2');
		seedSetting.run('r2PublicUrl', CDN);

		const bucket = {
			put: vi.fn(async () => {}),
			delete: vi.fn(async () => {}),
			list: vi.fn(async () => {
				throw new Error('R2 list timed out');
			})
		};
		const platform = { env: { DB: makeD1(sqlite), IMAGES: bucket } } as unknown as App.Platform;

		const result = await actions.clearCache({ platform } as never);

		expect(result).toMatchObject({ status: 500 });
		expect((result as { data: { error: string } }).data.error).toContain('r2: R2 list timed out');
		expect(bucket.delete).not.toHaveBeenCalled();
	});
});
