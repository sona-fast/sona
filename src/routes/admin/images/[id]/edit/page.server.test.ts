import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { characters } from '$lib/server/db/schema';
import { actions } from './+page.server';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses,
// same approach as admin/characters/page.server.test.ts.
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
	sqlite.exec(`CREATE TABLE characters (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
		is_owner INTEGER NOT NULL DEFAULT 0, reference_image_id INTEGER, created_at TEXT NOT NULL DEFAULT ''
	);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

// The reference action ends in redirect(302, …), which throws; swallow it so the
// test can assert the resulting DB state.
async function callReference(args: { params: { id: string }; request: Request; platform: App.Platform }) {
	try {
		await actions.reference(args as never);
	} catch (e) {
		if (!(e && typeof e === 'object' && 'status' in e && 'location' in e)) throw e;
	}
}

function form(fields: Record<string, string>): Request {
	const fd = new FormData();
	for (const [k, v] of Object.entries(fields)) fd.set(k, v);
	return new Request('http://localhost/admin/images/5/edit?/reference', { method: 'POST', body: fd });
}

async function refOf(db: ReturnType<typeof makeDb>['db'], id: number) {
	const row = await db.select({ ref: characters.referenceImageId }).from(characters).where(eq(characters.id, id)).get();
	return row?.ref ?? null;
}

describe('admin image edit — reference action', () => {
	it('sets the owner character reference image to this image', async () => {
		const { db, platform } = makeDb();
		const [c] = await db.insert(characters).values({ name: 'Owner', isOwner: true }).returning({ id: characters.id });

		await callReference({ params: { id: '5' }, request: form({}), platform });
		expect(await refOf(db, c.id)).toBe(5);
	});

	it('clears the reference image when clear is set', async () => {
		const { db, platform } = makeDb();
		const [c] = await db
			.insert(characters)
			.values({ name: 'Owner', isOwner: true, referenceImageId: 5 })
			.returning({ id: characters.id });

		await callReference({ params: { id: '5' }, request: form({ clear: 'on' }), platform });
		expect(await refOf(db, c.id)).toBe(null);
	});

	it('fails and writes nothing when there is no owner character', async () => {
		const { db, platform } = makeDb();
		const [c] = await db.insert(characters).values({ name: 'Featured', isOwner: false }).returning({ id: characters.id });

		const result = await actions.reference({ params: { id: '5' }, request: form({}), platform } as never);
		expect((result as { status: number }).status).toBe(400);
		expect(await refOf(db, c.id)).toBe(null);
	});
});
