import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettings, saveSettings, clearSettingsCache } from './settings';
import type { Database } from './db';

// These tests pin the per-isolate settings cache that sits on the hot path of
// every request. The cache exists to avoid a D1 round-trip per page load; the
// danger is the opposite failure — serving a stale setting after an admin edit.
// So the suite proves BOTH halves: that reads are cached within the TTL, AND
// that every mutation/bypass path returns fresh data.

/**
 * Minimal fake of the Drizzle DB surface `getSettings` touches: it only does
 * `await db.select().from(siteSettings)`, which resolves to the rows array.
 * Each call is counted so we can assert when the cache absorbed a read.
 */
function fakeReadDb(rows: Array<{ key: string; value: string }>) {
	const calls = { count: 0 };
	const db = {
		select: () => ({
			from: () => {
				calls.count += 1;
				return Promise.resolve(rows);
			}
		})
	} as unknown as Database;
	return { db, calls };
}

/** A DB whose read throws — mimics the "table doesn't exist yet" deploy window. */
function throwingDb(): Database {
	return {
		select: () => ({
			from: () => Promise.reject(new Error('no such table: site_settings'))
		})
	} as unknown as Database;
}

beforeEach(() => {
	clearSettingsCache();
});

afterEach(() => {
	vi.useRealTimers();
	clearSettingsCache();
});

describe('getSettings — mapping & defaults', () => {
	it('maps stored rows over the defaults', async () => {
		const { db } = fakeReadDb([
			{ key: 'siteName', value: 'My Gallery' },
			{ key: 'storageProvider', value: 'r2' }
		]);
		const s = await getSettings(db);
		expect(s.siteName).toBe('My Gallery');
		expect(s.storageProvider).toBe('r2');
		// Unset keys fall back to defaults.
		expect(s.r2PublicUrl).toBe('https://cdn.sparky.ink');
	});

	it('defaults autoResyncEnabled to false when unset', async () => {
		// Opt-in: an absent key must read as off so the cron stays a no-op.
		const { db } = fakeReadDb([]);
		const s = await getSettings(db);
		expect(s.autoResyncEnabled).toBe(false);
	});

	it("parses autoResyncEnabled from the text 'true'", async () => {
		// Booleans live in the TEXT value column as 'true'/'false'.
		const { db } = fakeReadDb([{ key: 'autoResyncEnabled', value: 'true' }]);
		const s = await getSettings(db);
		expect(s.autoResyncEnabled).toBe(true);
	});

	it("reads any non-'true' value of autoResyncEnabled as false", async () => {
		const { db } = fakeReadDb([{ key: 'autoResyncEnabled', value: 'false' }]);
		const s = await getSettings(db);
		expect(s.autoResyncEnabled).toBe(false);
	});

	it('coerces an unknown storageProvider back to the safe default', async () => {
		// storageProvider drives WHERE uploads are written — an unexpected value
		// must not silently become a third "provider".
		const { db } = fakeReadDb([{ key: 'storageProvider', value: 'wasabi' }]);
		const s = await getSettings(db);
		expect(s.storageProvider).toBe('uploadthing');
	});

	it('returns defaults (and does NOT cache) when the read throws', async () => {
		const failing = throwingDb();
		const first = await getSettings(failing);
		expect(first.siteName).toBe('sparky.ink');

		// A failure must not poison the cache — the next call has to retry and can
		// succeed once the table exists.
		const { db, calls } = fakeReadDb([{ key: 'siteName', value: 'Recovered' }]);
		const second = await getSettings(db);
		expect(second.siteName).toBe('Recovered');
		expect(calls.count).toBe(1);
	});
});

describe('getSettings — caching', () => {
	it('serves a second read from cache without re-querying', async () => {
		const { db, calls } = fakeReadDb([{ key: 'siteName', value: 'Cached' }]);
		await getSettings(db);
		await getSettings(db);
		expect(calls.count).toBe(1);
	});

	it('{ fresh: true } bypasses the cache and re-queries', async () => {
		const { db, calls } = fakeReadDb([{ key: 'siteName', value: 'Cached' }]);
		await getSettings(db); // primes cache
		await getSettings(db, { fresh: true });
		expect(calls.count).toBe(2);
	});

	it('re-queries after the TTL expires', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { db, calls } = fakeReadDb([{ key: 'siteName', value: 'Cached' }]);

		await getSettings(db);
		expect(calls.count).toBe(1);

		// Still inside the 60s TTL → cache hit.
		vi.setSystemTime(59_000);
		await getSettings(db);
		expect(calls.count).toBe(1);

		// Past the TTL → fresh read.
		vi.setSystemTime(61_000);
		await getSettings(db);
		expect(calls.count).toBe(2);
	});

	it('clearSettingsCache() forces the next read to re-query', async () => {
		const { db, calls } = fakeReadDb([{ key: 'siteName', value: 'Cached' }]);
		await getSettings(db);
		clearSettingsCache();
		await getSettings(db);
		expect(calls.count).toBe(2);
	});
});

describe('saveSettings — invalidation', () => {
	it('clears the cache so a subsequent read reflects the write', async () => {
		// Prime the cache with the "old" value.
		const before = fakeReadDb([{ key: 'siteName', value: 'Old' }]);
		expect((await getSettings(before.db)).siteName).toBe('Old');

		// A write DB that reports "no existing row" so saveSettings takes the insert
		// path; the actual persistence is irrelevant here — we're asserting the
		// cache is dropped on save.
		const writeDb = {
			select: () => ({ from: () => ({ where: () => ({ get: async () => undefined }) }) }),
			insert: () => ({ values: async () => undefined })
		} as unknown as Database;
		await saveSettings(writeDb, { siteName: 'New' });

		// Cache must have been invalidated → this read hits the DB and sees "New".
		const after = fakeReadDb([{ key: 'siteName', value: 'New' }]);
		expect((await getSettings(after.db)).siteName).toBe('New');
		expect(after.calls.count).toBe(1);
	});

	it('persists a boolean setting as the string value the TEXT column requires', async () => {
		// The value column is TEXT, so a boolean toggle must be stored as 'true' and
		// then round-trips back through getSettings's parser to a real boolean.
		const inserted: Array<{ key: string; value: unknown }> = [];
		const writeDb = {
			select: () => ({ from: () => ({ where: () => ({ get: async () => undefined }) }) }),
			insert: () => ({ values: async (row: { key: string; value: unknown }) => void inserted.push(row) })
		} as unknown as Database;

		await saveSettings(writeDb, { autoResyncEnabled: true });
		expect(inserted).toEqual([{ key: 'autoResyncEnabled', value: 'true' }]);

		// And the stored string reads back as a boolean.
		const { db } = fakeReadDb(inserted as Array<{ key: string; value: string }>);
		expect((await getSettings(db)).autoResyncEnabled).toBe(true);
	});

	it('leaves existing string settings unchanged through the String() coercion', async () => {
		const inserted: Array<{ key: string; value: unknown }> = [];
		const writeDb = {
			select: () => ({ from: () => ({ where: () => ({ get: async () => undefined }) }) }),
			insert: () => ({ values: async (row: { key: string; value: unknown }) => void inserted.push(row) })
		} as unknown as Database;

		await saveSettings(writeDb, { siteName: 'My Gallery' });
		expect(inserted).toEqual([{ key: 'siteName', value: 'My Gallery' }]);
	});
});
