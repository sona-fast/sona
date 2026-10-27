import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { tags } from '$lib/server/db/schema';
import { load } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
		CREATE TABLE image_tags (image_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
	`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

describe('admin tags load — a junk ?page= serves page 1', () => {
	// Number('abc') is NaN, which reached the OFFSET and the pager.
	it('serves page 1 for ?page=abc', async () => {
		const { db, platform } = makeDb();
		await db.insert(tags).values([{ name: 'fox' }, { name: 'wolf' }]);

		const url = new URL('http://localhost/admin/tags?page=abc');
		const data = (await load({ platform, url } as never)) as unknown as { page: number; tags: { name: string }[] };
		expect(data.page).toBe(1);
		expect(data.tags.map((t) => t.name)).toEqual(['fox', 'wolf']);
	});
});
