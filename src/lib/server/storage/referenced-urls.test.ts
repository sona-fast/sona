import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { is, getTableColumns, getTableName } from 'drizzle-orm';
import { SQLiteTable, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as schema from '$lib/server/db/schema';
import type { SiteSettings } from '$lib/server/settings';
import { URL_COLUMNS, collectReferencedUrls } from './referenced-urls';

import { makeD1 } from '$lib/server/test/d1';

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
		let tablesSeen = 0;
		let urlColumnsSeen = 0;
		for (const exported of Object.values(schema)) {
			if (!is(exported, SQLiteTable)) continue;
			tablesSeen++;
			const tableName = getTableName(exported);
			for (const key of Object.keys(getTableColumns(exported))) {
				if (!/url$/i.test(key)) continue;
				urlColumnsSeen++;
				expect(
					covered.get(tableName)?.has(key),
					`URL column ${tableName}.${key} is missing from URL_COLUMNS — orphan cleanup would delete the files it references. Add it to the source list in referenced-urls.ts.`
				).toBe(true);
			}
		}
		// Anti-vacuity: if drizzle's is()/table metadata ever stops recognising
		// the schema exports, the loop above would pass having checked NOTHING —
		// silently disabling this guard on a destructive path. The real schema
		// has many tables and well over ten URL columns.
		expect(tablesSeen).toBeGreaterThan(0);
		expect(urlColumnsSeen).toBeGreaterThan(10);
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
