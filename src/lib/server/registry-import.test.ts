import { describe, it, expect, vi, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here
// (same shim as sticker-import.test.ts).
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '$lib/server/db/schema';
import { artists } from '$lib/server/db/schema';
import type { RegistryArtist } from './registry';
import { fetchRegistryCatalog, planImport, importRegistryCatalog } from './registry-import';

// The registry client is mocked so the import path is exercisable offline:
// registryDelta serves `catalogPages` (set per test); everything else stays real.
let catalogPages: { artists: RegistryArtist[]; nextCursor: string | null }[] = [];
let deltaCalls = 0;

vi.mock('./registry', async (importOriginal) => {
	const mod = await importOriginal<typeof import('./registry')>();
	return {
		...mod,
		registryDelta: vi.fn(async () => {
			const page = catalogPages[deltaCalls] ?? { artists: [], nextCursor: null };
			deltaCalls++;
			return page;
		})
	};
});

import { makeD1 } from '$lib/server/test/d1';

const DDL = `
CREATE TABLE artists (
	id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT, twitter_url TEXT,
	bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT, deviantart_url TEXT,
	patreon_url TEXT, instagram_url TEXT, global_id TEXT UNIQUE, registry_version INTEGER,
	registry_synced_at TEXT, aliases TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL
);
`;

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(DDL);
	return drizzle(makeD1(sqlite), { schema });
}

const env = { REGISTRY_API_KEY: 'k' } as unknown as App.Platform['env'];

function ra(overrides: Partial<RegistryArtist> & { globalId: string }): RegistryArtist {
	return {
		displayName: 'Artist ' + overrides.globalId,
		avatarUrl: null,
		bio: null,
		socials: {},
		status: 'active',
		mergedInto: null,
		version: 1,
		updatedAt: '2026-01-01T00:00:00Z',
		...overrides
	};
}

beforeEach(() => {
	catalogPages = [];
	deltaCalls = 0;
});

describe('fetchRegistryCatalog', () => {
	it('returns [] when the registry is disabled', async () => {
		expect(await fetchRegistryCatalog(undefined)).toEqual([]);
		expect(deltaCalls).toBe(0);
	});

	it('pages through the delta feed, keeping only active records, deduped', async () => {
		catalogPages = [
			{
				artists: [ra({ globalId: 'g1' }), ra({ globalId: 'g2', status: 'tombstoned' })],
				nextCursor: 'c1'
			},
			{
				artists: [ra({ globalId: 'g1', version: 2 }), ra({ globalId: 'g3' })],
				nextCursor: null
			}
		];
		const catalog = await fetchRegistryCatalog(env);
		expect(catalog.map((a) => a.globalId).sort()).toEqual(['g1', 'g3']);
		// The duplicate g1 collapsed to the later record.
		expect(catalog.find((a) => a.globalId === 'g1')?.version).toBe(2);
	});

	it('degrades to [] when a 200 delta response has no artists array', async () => {
		// Schema drift or an error page served as 200 — must not throw (this was
		// the one unguarded 500 path into the admin artists loader).
		catalogPages = [{ error: 'oops' } as unknown as (typeof catalogPages)[number]];
		expect(await fetchRegistryCatalog(env)).toEqual([]);
	});
});

describe('planImport', () => {
	it('skips linked global_ids and handle-matched unlinked locals; creates the rest', () => {
		const catalog = [
			ra({ globalId: 'g-linked' }),
			ra({ globalId: 'g-handle', socials: { twitterUrl: 'https://x.com/lunarpaws' } }),
			ra({ globalId: 'g-new' })
		];
		const locals = [
			{ globalId: 'g-linked' },
			{ globalId: null, twitterUrl: 'https://twitter.com/LunarPaws' }
		];
		const plan = planImport(catalog, locals);
		expect(plan.total).toBe(3);
		expect(plan.skippedLinked).toBe(1);
		expect(plan.skippedHandleMatched).toBe(1);
		expect(plan.toCreate.map((a) => a.globalId)).toEqual(['g-new']);
	});

	it('does not handle-skip against a local already linked to a different id', () => {
		// A LINKED local sharing a handle must not block creation — only unlinked
		// locals are candidates for the backfill link (mirrors /api/artists).
		const catalog = [ra({ globalId: 'g-a', socials: { twitterUrl: 'https://x.com/same' } })];
		const locals = [{ globalId: 'g-other', twitterUrl: 'https://x.com/same' }];
		const plan = planImport(catalog, locals);
		expect(plan.toCreate).toHaveLength(1);
		expect(plan.skippedHandleMatched).toBe(0);
	});
});

describe('importRegistryCatalog', () => {
	it('creates local artists with registry stamps and sanitized data', async () => {
		const db = makeDb();
		catalogPages = [
			{
				artists: [
					ra({
						globalId: 'g1',
						displayName: 'Lunar Paws',
						version: 7,
						avatarUrl: 'https://cdn.example.com/a.png',
						socials: { twitterUrl: 'https://x.com/lunarpaws', blueskyUrl: 'javascript:alert(1)' },
						aliases: [{ displayName: 'Old Name', socials: {} }]
					})
				],
				nextCursor: null
			}
		];
		const result = await importRegistryCatalog(db, env);
		expect(result).toEqual({
			total: 1,
			created: 1,
			failed: 0,
			skippedLinked: 0,
			skippedHandleMatched: 0
		});

		const row = await db.select().from(artists).where(eq(artists.globalId, 'g1')).get();
		expect(row).toBeDefined();
		expect(row!.name).toBe('Lunar Paws');
		expect(row!.registryVersion).toBe(7);
		expect(row!.registrySyncedAt).toBeTruthy();
		expect(row!.avatarUrl).toBe('https://cdn.example.com/a.png');
		expect(row!.twitterUrl).toBe('https://x.com/lunarpaws');
		expect(row!.blueskyUrl).toBeNull(); // javascript: dropped by sanitizeUrl
		expect(JSON.parse(row!.aliases!)).toEqual([{ displayName: 'Old Name', socials: {} }]);
	});

	it('skips linked and handle-matched artists without modifying any local row', async () => {
		const db = makeDb();
		const now = new Date().toISOString();
		await db.insert(artists).values({
			name: 'My Custom Name', // deliberately differs from the registry record
			globalId: 'g-linked',
			registryVersion: 1,
			createdAt: now
		});
		await db.insert(artists).values({
			name: 'Unlinked Local',
			twitterUrl: 'https://twitter.com/SharedHandle',
			createdAt: now
		});

		catalogPages = [
			{
				artists: [
					ra({ globalId: 'g-linked', displayName: 'Registry Name', version: 9 }),
					ra({ globalId: 'g-handle', socials: { twitterUrl: 'https://x.com/sharedhandle' } }),
					ra({ globalId: 'g-new' })
				],
				nextCursor: null
			}
		];
		const before = await db.select().from(artists);
		const result = await importRegistryCatalog(db, env);
		expect(result).toMatchObject({ created: 1, skippedLinked: 1, skippedHandleMatched: 1 });

		// No-overwrite invariant: every pre-existing row is byte-identical.
		const after = await db.select().from(artists);
		for (const b of before) {
			expect(after.find((a) => a.id === b.id)).toEqual(b);
		}
		// The handle-matched local was NOT linked by import (backfill sync does that).
		const unlinked = after.find((a) => a.name === 'Unlinked Local');
		expect(unlinked!.globalId).toBeNull();
		// Only g-new was created.
		expect(after.filter((a) => a.globalId === 'g-new')).toHaveLength(1);
	});

	it('is idempotent: a second run creates nothing new', async () => {
		const db = makeDb();
		const pages = [
			{
				artists: [ra({ globalId: 'g1' }), ra({ globalId: 'g2' })],
				nextCursor: null
			}
		];
		catalogPages = pages;
		const first = await importRegistryCatalog(db, env);
		expect(first!.created).toBe(2);

		deltaCalls = 0;
		catalogPages = pages;
		const second = await importRegistryCatalog(db, env);
		expect(second).toMatchObject({ created: 0, skippedLinked: 2, failed: 0 });
		expect(await db.select().from(artists)).toHaveLength(2);
	});

	it('returns null when the registry is disabled', async () => {
		const db = makeDb();
		expect(await importRegistryCatalog(db, undefined)).toBeNull();
	});
});
