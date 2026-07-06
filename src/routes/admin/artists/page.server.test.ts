import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';

// submitToRegistry's registry call is the one thing we don't want to hit for real;
// stub just that export and keep the rest of the module (isRegistryEnabled,
// resolveRegistryEnv, …) intact so load's tests still exercise the real code.
const { mockRegistrySubmit } = vi.hoisted(() => ({ mockRegistrySubmit: vi.fn() }));
vi.mock('$lib/server/registry', async (importActual) => ({
	...(await importActual<typeof import('$lib/server/registry')>()),
	registrySubmit: mockRegistrySubmit
}));

import { load, actions } from './+page.server';

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
	CREATE TABLE artists (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT,
		global_id TEXT UNIQUE, registry_version INTEGER, registry_synced_at TEXT,
		aliases TEXT, created_at TEXT NOT NULL
	);
	CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER NOT NULL);
	CREATE TABLE stickers (id INTEGER PRIMARY KEY AUTOINCREMENT, artist_id INTEGER NOT NULL);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function loadEvent(platform: App.Platform, q?: string) {
	const url = new URL('http://localhost/admin/artists');
	if (q !== undefined) url.searchParams.set('q', q);
	return { platform, url } as never;
}

// The registry itself must never be hit from tests: fail every fetch so the
// client's graceful-degradation fallbacks (empty submissions/catalog) apply.
beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('admin artists load — registry enablement', () => {
	it('reports registryEnabled with a D1-stored fork key and no env secret', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });

		const result = await load(loadEvent(platform));
		expect(result).toMatchObject({ registryEnabled: true });
	});

	it('reports registry disabled when nothing is stored and no env secret exists', async () => {
		const { platform } = makeDb();

		const result = await load(loadEvent(platform));
		expect(result).toMatchObject({ registryEnabled: false });
	});
});

describe('admin artists load — former names (aliases)', () => {
	it('exposes parsed alias display names as formerly, skipping the current name', async () => {
		const { db, platform } = makeDb();
		await db.insert(schema.artists).values({
			name: 'Zaps',
			aliases: JSON.stringify([
				{ displayName: 'Boltie', socials: {} },
				// Identical to the current display name (case-insensitively) — must be skipped.
				{ displayName: 'zaps', socials: {} }
			])
		});

		// load's SvelteKit signature admits void; the cast narrows to the data shape.
		const result = (await load(loadEvent(platform))) as { artists: Array<{ formerly: string[] }> };
		expect(result.artists).toHaveLength(1);
		expect(result.artists[0].formerly).toEqual(['Boltie']);
	});

	it('exposes an empty formerly for artists without aliases or with malformed JSON', async () => {
		const { db, platform } = makeDb();
		await db.insert(schema.artists).values({ name: 'NoAka' });
		await db.insert(schema.artists).values({ name: 'BadJson', aliases: 'not-json{' });

		const result = (await load(loadEvent(platform))) as { artists: Array<{ formerly: string[] }> };
		expect(result.artists.map((a) => a.formerly)).toEqual([[], []]);
	});
});

describe('admin artists load — server-side search matches AKA names', () => {
	// Zaps was formerly "Boltie"; the alias JSON also carries a social URL we must
	// NOT match on. Nova is an unrelated artist used to prove the search narrows.
	async function seedRenamedArtist(db: ReturnType<typeof makeDb>['db']) {
		await db.insert(schema.artists).values({
			name: 'Zaps',
			aliases: JSON.stringify([{ displayName: 'Boltie', socials: { twitter: 'https://x.com/boltie' } }])
		});
		await db.insert(schema.artists).values({ name: 'Nova' });
	}

	it('finds an artist by a former (alias) display name', async () => {
		const { db, platform } = makeDb();
		await seedRenamedArtist(db);

		const result = (await load(loadEvent(platform, 'boltie'))) as {
			artists: Array<{ name: string }>;
			total: number;
		};
		expect(result.artists.map((a) => a.name)).toEqual(['Zaps']);
		// Count query shares the widened where — it must reflect the alias hit too.
		expect(result.total).toBe(1);
	});

	it('does NOT match on a URL buried inside the aliases JSON (precision)', async () => {
		const { db, platform } = makeDb();
		await seedRenamedArtist(db);

		const result = (await load(loadEvent(platform, 'x.com'))) as {
			artists: Array<{ name: string }>;
			total: number;
		};
		expect(result.artists).toHaveLength(0);
		expect(result.total).toBe(0);
	});

	it('still matches on the current name, and tolerates NULL/malformed aliases', async () => {
		const { db, platform } = makeDb();
		await seedRenamedArtist(db);
		// A malformed-JSON aliases row must not make json_each throw for the query.
		await db.insert(schema.artists).values({ name: 'BadJson', aliases: 'not-json{' });

		const result = (await load(loadEvent(platform, 'zaps'))) as {
			artists: Array<{ name: string }>;
			total: number;
		};
		expect(result.artists.map((a) => a.name)).toEqual(['Zaps']);
		expect(result.total).toBe(1);
	});
});

describe('submitToRegistry action — surfaces the registry outcome', () => {
	// Enable the registry via a stored fork key (same path the load tests use) and
	// seed the artist row the action reads, then return its id.
	async function seedEnabledArtist(db: ReturnType<typeof makeDb>['db']) {
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'stored-key' });
		const row = await db.insert(schema.artists).values({ name: 'Nyx' }).returning({ id: schema.artists.id }).get();
		return row.id;
	}

	function submitEvent(platform: App.Platform, id: number) {
		const body = new FormData();
		body.append('id', String(id));
		return {
			platform,
			url: new URL('http://localhost/admin/artists'),
			request: new Request('http://localhost/admin/artists', { method: 'POST', body })
		} as never;
	}

	beforeEach(() => mockRegistrySubmit.mockReset());

	it('returns fail(409) carrying the registry’s own reason when the submission is refused', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db);
		mockRegistrySubmit.mockResolvedValue({ error: 'This artist was removed from the registry and cannot be resubmitted.' });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toMatchObject({ status: 409 });
		expect((result as { data: { error: string } }).data.error).toMatch(/removed from the registry/i);
	});

	it('returns fail(502) when the registry is unreachable (null result)', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db);
		mockRegistrySubmit.mockResolvedValue(null);

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toMatchObject({ status: 502 });
		expect((result as { data: { error: string } }).data.error).toMatch(/unreachable/i);
	});

	it('returns success on a clean submission', async () => {
		const { db, platform } = makeDb();
		const id = await seedEnabledArtist(db);
		mockRegistrySubmit.mockResolvedValue({ id: 1, status: 'pending', matchedGlobalId: null });

		const result = await actions.submitToRegistry(submitEvent(platform, id));
		expect(result).toEqual({ success: true, submitted: true });
	});
});
