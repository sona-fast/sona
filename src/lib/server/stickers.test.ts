import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and @types/better-sqlite3 isn't a dep,
// so import it untyped — it's only the runtime backend for the in-memory test DB.
// @ts-expect-error -- no type declarations for better-sqlite3
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { derivePackShape, inferAppendedArtistId, resolveStickerArtistIds, findStickers, listPacks } from './stickers';
import * as schema from './db/schema';
import type { Database as Db } from './db';

// The single-artist invariant is the core data rule of the stickers feature:
// a pack with a managerArtistId is single-artist and
// EVERY sticker must be credited to that manager; without one, the pack is
// self-managed and may mix artists. These two pure functions encode that rule —
// resolveStickerArtistIds enforces it on every write path, derivePackShape reads
// it back. If a future edit weakens either, these fail loudly.

describe('resolveStickerArtistIds (single-artist invariant)', () => {
	it('overrides every per-sticker artist with the manager when one is set', () => {
		// Manager 7 set; per-sticker says 1, 2, 3 → all must collapse to 7.
		expect(resolveStickerArtistIds(7, [1, 2, 3])).toEqual([7, 7, 7]);
	});

	it('keeps per-sticker artists when there is no manager (self-managed pack)', () => {
		expect(resolveStickerArtistIds(null, [1, 2, 3])).toEqual([1, 2, 3]);
	});

	it('preserves length and order', () => {
		expect(resolveStickerArtistIds(null, [9, 9, 4, 9])).toEqual([9, 9, 4, 9]);
		expect(resolveStickerArtistIds(5, [9, 9, 4, 9])).toHaveLength(4);
	});

	it('handles an empty sticker list', () => {
		expect(resolveStickerArtistIds(7, [])).toEqual([]);
		expect(resolveStickerArtistIds(null, [])).toEqual([]);
	});
});

describe('derivePackShape', () => {
	it('is single when a manager is set, regardless of distinct artists', () => {
		// The invariant guarantees all stickers share the manager, so a manager
		// always means single — even if stale distinct ids are passed.
		expect(derivePackShape(7, [7])).toBe('single');
		expect(derivePackShape(7, [])).toBe('single');
		expect(derivePackShape(7, [1, 2])).toBe('single');
	});

	it('is single when self-managed with zero or one distinct artist', () => {
		expect(derivePackShape(null, [])).toBe('single');
		expect(derivePackShape(null, [4])).toBe('single');
	});

	it('is multi when self-managed with more than one distinct artist', () => {
		expect(derivePackShape(null, [4, 5])).toBe('multi');
		expect(derivePackShape(null, [1, 2, 3])).toBe('multi');
	});
});

describe('inferAppendedArtistId (cron append attribution, #184)', () => {
	it('inherits the single attributed artist on an unmanaged pack', () => {
		// One distinct non-null artist is unambiguous even when some existing
		// stickers are unattributed (the nulls are filtered before the call).
		expect(inferAppendedArtistId([4])).toBe(4);
	});

	it('stays unattributed with zero attributed or mixed artists', () => {
		expect(inferAppendedArtistId([])).toBeNull();
		expect(inferAppendedArtistId([4, 5])).toBeNull();
	});
});

// The read queries (findStickers, listPacks) must never let an IN-list exceed
// D1's bound-parameter ceiling: q=face expands to 200+ emoji glyphs and a busy
// site can list 90+ packs, both of which used to overflow and 500 the page. These
// tests run the real queries against an in-memory SQLite that enforces a D1-like
// param cap, so a regression that drops the chunking throws "too many SQL
// variables" here instead of in production.

// D1's real ceiling is ~100 bound params per statement; the code chunks at 90.
const D1_PARAM_CAP = 100;

/**
 * Wrap a better-sqlite3 statement so any execution bound with more than the cap
 * throws — mimicking D1's "too many SQL variables". Drizzle calls all/get/run/values
 * with spread params and chains `.raw()`, so we guard those and keep raw() chainable.
 */
function capStatement(stmt: any) {
	const proxy: any = new Proxy(stmt, {
		get(target, prop) {
			const value = target[prop];
			if (typeof value !== 'function') return value;
			if (prop === 'all' || prop === 'get' || prop === 'run' || prop === 'values') {
				return (...params: unknown[]) => {
					if (params.length > D1_PARAM_CAP) throw new Error(`too many SQL variables (${params.length})`);
					return value.apply(target, params);
				};
			}
			// raw/pluck/expand/bind/safeIntegers mutate-and-return the statement; keep the proxy.
			return (...args: unknown[]) => {
				const r = value.apply(target, args);
				return r === target ? proxy : r;
			};
		}
	});
	return proxy;
}

/** A better-sqlite3 client whose prepared statements enforce the D1 param cap. */
function cappedClient(sqlite: any) {
	return new Proxy(sqlite, {
		get(target, prop) {
			if (prop === 'prepare') return (sql: string) => capStatement(target.prepare(sql));
			const value = (target as any)[prop];
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

function makeDb(): Db {
	const sqlite = new BetterSqlite3(':memory:');
	sqlite.exec(`
		CREATE TABLE artists (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avatar_url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, global_id TEXT,
			registry_version INTEGER, registry_synced_at TEXT, avatar_resolved_at TEXT, created_at TEXT NOT NULL
		);
		CREATE TABLE characters (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
			twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
			deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
			is_owner INTEGER NOT NULL DEFAULT 0, reference_image_id INTEGER, created_at TEXT NOT NULL
		);
		CREATE TABLE sticker_packs (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
			description TEXT, cover_image_url TEXT, character_id INTEGER NOT NULL,
			manager_artist_id INTEGER, telegram_url TEXT, source TEXT NOT NULL,
			published INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
		);
		CREATE TABLE stickers (
			id INTEGER PRIMARY KEY AUTOINCREMENT, pack_id INTEGER NOT NULL, artist_id INTEGER,
			image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER,
			format TEXT NOT NULL DEFAULT 'webp', position INTEGER NOT NULL DEFAULT 0,
			nsfw INTEGER NOT NULL DEFAULT 0, telegram_file_unique_id TEXT, created_at TEXT NOT NULL
		);
		CREATE TABLE sticker_emojis (sticker_id INTEGER NOT NULL, emoji TEXT NOT NULL);
	`);
	return drizzle(cappedClient(sqlite), { schema }) as unknown as Db;
}

describe('findStickers (emoji IN-list chunking past D1 param cap)', () => {
	it('chunks a huge glyph set, returns the right stickers deduped and ordered, instead of overflowing', async () => {
		const db = makeDb();
		await db.insert(schema.characters).values({ name: 'Sparky' });
		await db.insert(schema.stickerPacks).values({ name: 'Pack', slug: 'pack', characterId: 1, source: 'self-hosted', published: true });

		// Three stickers, positions chosen so dedupe + re-sort by (position, id) is observable.
		const inserted = await db
			.insert(schema.stickers)
			.values([
				{ packId: 1, imageUrl: 'a.webp', position: 5 }, // id 1 — matched, later position
				{ packId: 1, imageUrl: 'b.webp', position: 1 }, // id 2 — matched, earlier position
				{ packId: 1, imageUrl: 'c.webp', position: 0 } // id 3 — NOT matched
			])
			.returning({ id: schema.stickers.id });
		const [a, b, c] = inserted.map((r) => r.id);

		// 120 distinct query glyphs — past the cap, so the pre-fix single IN-list would throw.
		const glyphs = Array.from({ length: 120 }, (_, i) => `q${i}`);
		// Sticker A matches a glyph in the FIRST chunk; B matches one in a LATER chunk
		// AND one in the first chunk (so dedupe across chunks is exercised); C only
		// carries a glyph that is NOT in the query set.
		await db.insert(schema.stickerEmojis).values([
			{ stickerId: a, emoji: glyphs[3] },
			{ stickerId: b, emoji: glyphs[100] },
			{ stickerId: b, emoji: glyphs[10] },
			{ stickerId: c, emoji: 'unmatched' }
		]);

		const found = await findStickers(db, { emojis: glyphs, publishedOnly: true });
		// B (position 1) before A (position 5); each once; C excluded.
		expect(found.map((s) => s.id)).toEqual([b, a]);
		expect(found).toHaveLength(2);
	});

	it('still returns matches when publishedOnly is false', async () => {
		const db = makeDb();
		await db.insert(schema.characters).values({ name: 'Sparky' });
		await db.insert(schema.stickerPacks).values({ name: 'Draft', slug: 'draft', characterId: 1, source: 'self-hosted', published: false });
		const [s] = (await db.insert(schema.stickers).values({ packId: 1, imageUrl: 'd.webp' }).returning({ id: schema.stickers.id })).map((r) => r.id);
		const glyphs = Array.from({ length: 95 }, (_, i) => `g${i}`);
		await db.insert(schema.stickerEmojis).values({ stickerId: s, emoji: glyphs[50] });

		expect((await findStickers(db, { emojis: glyphs, publishedOnly: false })).map((x) => x.id)).toEqual([s]);
		// In a published-only view the draft pack's sticker is hidden.
		expect(await findStickers(db, { emojis: glyphs, publishedOnly: true })).toEqual([]);
	});
});

describe('listPacks (packId / characterId IN-list chunking past D1 param cap)', () => {
	it('lists 120 packs with correct counts instead of overflowing', async () => {
		const db = makeDb();
		const N = 120; // > cap, so a single packId/characterId IN-list would throw.
		// Seed in small row-batches: D1 (and our cap stub) limits params on writes too.
		const BATCH = 15; // ≤6 cols/pack row → ≤90 params per write, under the cap
		for (let i = 0; i < N; i += BATCH) {
			const n = Math.min(BATCH, N - i);
			await db.insert(schema.characters).values(
				Array.from({ length: n }, (_, j) => ({ name: `Char ${i + j}` }))
			);
			await db.insert(schema.stickerPacks).values(
				Array.from({ length: n }, (_, j) => ({
					name: `Pack ${i + j}`,
					slug: `pack-${i + j}`,
					characterId: i + j + 1, // distinct character per pack → characterId IN-list also > cap
					source: 'self-hosted' as const,
					published: true
				}))
			);
		}
		// Two stickers in pack 1, one in pack 2, none elsewhere — exercises countByPack.
		await db.insert(schema.stickers).values([
			{ packId: 1, imageUrl: 'p1a.webp', position: 0 },
			{ packId: 1, imageUrl: 'p1b.webp', position: 1 },
			{ packId: 2, imageUrl: 'p2a.webp', position: 0 }
		]);

		const packs = await listPacks(db, { publishedOnly: true });
		expect(packs).toHaveLength(N);
		const byId = new Map(packs.map((p) => [p.id, p]));
		expect(byId.get(1)!.stickerCount).toBe(2);
		expect(byId.get(1)!.previewImages).toEqual(['p1a.webp', 'p1b.webp']);
		expect(byId.get(1)!.character).toEqual({ id: 1, name: 'Char 0' });
		expect(byId.get(2)!.stickerCount).toBe(1);
		expect(byId.get(3)!.stickerCount).toBe(0);
	});
});
