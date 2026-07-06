import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { is, getTableColumns, getTableName } from 'drizzle-orm';
import { SQLiteTable, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import type { SiteSettings } from '$lib/server/settings';
import { URL_COLUMNS, collectReferencedUrls } from './referenced-urls';

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

describe('URL_COLUMNS completeness guard', () => {
	// Orphan cleanup deletes every stored object whose URL is NOT collected, so
	// a URL column missing from URL_COLUMNS means the files it references get
	// deleted. This guard enumerates the real schema (via drizzle's table
	// metadata, not source text) so a migration that adds a *Url column fails
	// the suite until collectReferencedUrls learns it.
	it('covers every column named *url in the schema', () => {
		const covered = new Map(
			URL_COLUMNS.map(({ table, columns }) => [getTableName(table), new Set(columns)])
		);
		for (const exported of Object.values(schema)) {
			if (!is(exported, SQLiteTable)) continue;
			const tableName = getTableName(exported);
			for (const key of Object.keys(getTableColumns(exported))) {
				if (!/url$/i.test(key)) continue;
				expect(
					covered.get(tableName)?.has(key),
					`URL column ${tableName}.${key} is missing from URL_COLUMNS — orphan cleanup would delete the files it references. Add it to the source list in referenced-urls.ts.`
				).toBe(true);
			}
		}
	});

	it('lists only columns that actually exist', () => {
		for (const { table, columns } of URL_COLUMNS) {
			const cols = getTableColumns(table);
			for (const c of columns) {
				expect(cols[c], `URL_COLUMNS lists unknown column ${getTableName(table)}.${c}`).toBeDefined();
			}
		}
	});
});

describe('collectReferencedUrls', () => {
	function makeDb() {
		const sqlite = new Database(':memory:');
		// Minimal tables: just the URL columns the collector selects, generated
		// from the same source list so DDL can't drift from the queries.
		for (const { table, columns } of URL_COLUMNS) {
			const cols = getTableColumns(table) as Record<string, SQLiteColumn>;
			const ddl = columns.map((c) => `"${cols[c].name}" TEXT`).join(', ');
			sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${ddl})`);
		}
		return { sqlite, db: drizzle(makeD1(sqlite), { schema }) };
	}

	it('unions URLs from every table plus URL-ish settings, dropping null/empty', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (image_url, thumbnail_url, source_post_url) VALUES (?, ?, ?)')
			.run('https://cdn.example.com/img.png', 'https://cdn.example.com/img.thumb.webp', null);
		sqlite
			.prepare('INSERT INTO stickers (image_url, thumbnail_url) VALUES (?, ?)')
			.run('https://cdn.example.com/stickers/s1.webp', '');
		sqlite
			.prepare('INSERT INTO artists (avatar_url, twitter_url) VALUES (?, ?)')
			.run('https://cdn.example.com/avatars/a1.png', 'https://twitter.com/someone');
		sqlite
			.prepare('INSERT INTO collections (cover_image_url) VALUES (?)')
			.run('https://cdn.example.com/covers/c1.png');
		sqlite
			.prepare('INSERT INTO fursuit_photos (image_url, photographer_url) VALUES (?, ?)')
			.run('https://cdn.example.com/fursuit/f1.jpg', 'https://furtrack.com/user/p');

		const settings = {
			adminAvatarUrl: 'https://cdn.example.com/avatars/admin.png',
			twitterUrl: '',
			r2PublicUrl: 'https://cdn.example.com'
		} as unknown as SiteSettings;

		const urls = new Set(await collectReferencedUrls(db, settings));
		expect(urls).toContain('https://cdn.example.com/img.png');
		expect(urls).toContain('https://cdn.example.com/img.thumb.webp');
		expect(urls).toContain('https://cdn.example.com/stickers/s1.webp');
		expect(urls).toContain('https://cdn.example.com/avatars/a1.png');
		expect(urls).toContain('https://cdn.example.com/covers/c1.png');
		expect(urls).toContain('https://cdn.example.com/fursuit/f1.jpg');
		// External URLs are deliberately over-collected (inert for providers).
		expect(urls).toContain('https://twitter.com/someone');
		expect(urls).toContain('https://furtrack.com/user/p');
		// Settings URL fields are included too (adminAvatarUrl may be R2-hosted).
		expect(urls).toContain('https://cdn.example.com/avatars/admin.png');
		// Null/empty values are dropped.
		expect(urls).not.toContain('');
		expect([...urls].some((u) => u == null)).toBe(false);
	});
});
