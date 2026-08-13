import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	getSettings,
	saveSettings,
	clearSettingsCache,
	getSupporterKeyStatus,
	clearSupporterKeyStatusCache,
	parseSonaColors,
	parseLines
} from './settings';
import { verifySupporterKey } from './supporter-key';
import type { Database } from './db';

// Verification is stubbed (a passing token needs the sona.fast PRIVATE key); the
// resolver keeps the real shaping, so the countdown these tests assert on is the
// production one. The crypto itself is covered in supporter-key.test.ts.
vi.mock('$lib/server/supporter-key', async (importActual) =>
	(await import('$lib/server/test/supporter-key-mock')).supporterKeyMockModule(
		importActual as () => Promise<typeof import('$lib/server/supporter-key')>
	)
);

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
	clearSupporterKeyStatusCache();
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
		// Unset keys fall back to defaults (neutral/empty for a fresh fork).
		expect(s.r2PublicUrl).toBe('');
	});

	it('maps instagramUrl from a stored row and defaults it to blank', async () => {
		const { db } = fakeReadDb([
			{ key: 'instagramUrl', value: 'https://www.instagram.com/sona.e2e.example' }
		]);
		const s = await getSettings(db);
		expect(s.instagramUrl).toBe('https://www.instagram.com/sona.e2e.example');

		clearSettingsCache();
		const { db: empty } = fakeReadDb([]);
		// Blank default keeps the row hidden on /connect and /about until set.
		expect((await getSettings(empty)).instagramUrl).toBe('');
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

	// aiPageEnabled is the one DEFAULT-ON boolean (SONA-167): the fleet
	// discloses unless a fork explicitly opts out, so absence means ON — the
	// opposite polarity of autoResyncEnabled above, pinned so nobody
	// "normalizes" it to === 'true' and silently turns the page off fleet-wide.
	it('defaults aiPageEnabled ON when the row is absent', async () => {
		const { db } = fakeReadDb([]);
		const s = await getSettings(db);
		expect(s.aiPageEnabled).toBe(true);
	});

	it("turns aiPageEnabled off only on an explicit stored 'false'", async () => {
		const { db } = fakeReadDb([{ key: 'aiPageEnabled', value: 'false' }]);
		const s = await getSettings(db);
		expect(s.aiPageEnabled).toBe(false);
	});

	it('coerces an unknown storageProvider back to the safe default', async () => {
		// storageProvider drives WHERE uploads are written — an unexpected value
		// must not silently become a third "provider".
		const { db } = fakeReadDb([{ key: 'storageProvider', value: 'wasabi' }]);
		const s = await getSettings(db);
		expect(s.storageProvider).toBe('uploadthing');
	});

	it('maps a stored galleryDefaultSort and defaults it to newest when unset', async () => {
		const { db } = fakeReadDb([{ key: 'galleryDefaultSort', value: 'commissioned-newest' }]);
		expect((await getSettings(db)).galleryDefaultSort).toBe('commissioned-newest');

		clearSettingsCache();
		const empty = fakeReadDb([]);
		expect((await getSettings(empty.db)).galleryDefaultSort).toBe('newest');
	});

	it('coerces an unknown galleryDefaultSort back to the safe default', async () => {
		// An out-of-range value must not reach the gallery's orderBy switch.
		const { db } = fakeReadDb([{ key: 'galleryDefaultSort', value: 'by-vibes' }]);
		expect((await getSettings(db)).galleryDefaultSort).toBe('newest');
	});

	it('maps the three-path profile fields (sona profile + contact email)', async () => {
		// These feed the /art, /connect and /share pages of the threePath landing.
		const { db } = fakeReadDb([
			{ key: 'contactEmail', value: 'paws@example.com' },
			{ key: 'privacyPolicy', value: 'Our custom privacy policy.' },
			{ key: 'termsOfService', value: 'Our custom terms.' },
			{ key: 'sonaSpecies', value: 'Wolf' }
		]);
		const s = await getSettings(db);
		expect(s.contactEmail).toBe('paws@example.com');
		expect(s.privacyPolicy).toBe('Our custom privacy policy.');
		expect(s.termsOfService).toBe('Our custom terms.');
		expect(s.sonaSpecies).toBe('Wolf');
		// Both stamps are unset here → empty, so the pages show the defaults' date.
		expect(s.privacyUpdatedAt).toBe('');
		expect(s.termsUpdatedAt).toBe('');
		// Unset profile keys fall back to neutral empties — a fresh fork's /art
		// page renders without any placeholder character data.
		expect(parseSonaColors(s.sonaColors)).toEqual([]);
		expect(s.sonaDos).toBe('');
	});

	it('maps a stored privacyUpdatedAt/termsUpdatedAt (the legal-pages "last updated" stamps)', async () => {
		const { db } = fakeReadDb([
			{ key: 'privacyUpdatedAt', value: '2026-05-01' },
			{ key: 'termsUpdatedAt', value: '2026-06-02' }
		]);
		const s = await getSettings(db);
		expect(s.privacyUpdatedAt).toBe('2026-05-01');
		expect(s.termsUpdatedAt).toBe('2026-06-02');
	});

	it('returns defaults (and does NOT cache) when the read throws', async () => {
		const failing = throwingDb();
		const first = await getSettings(failing);
		expect(first.siteName).toBe('Sona');

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

/**
 * Minimal fake of the surface `getRawSetting` touches — `db.select().from(t)
 * .where(...).get()` — resolving to the single stored row. Reads are counted so
 * a cache hit is observable as "no D1 round-trip", and `value` is mutable so a
 * test can simulate the row changing under the cache.
 */
function fakeKeyDb(value: string | null) {
	const state = { value, reads: 0 };
	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					get: async () => {
						state.reads += 1;
						return state.value === null ? undefined : { key: 'supporterKey', value: state.value };
					}
				})
			})
		})
	} as unknown as Database;
	return { db, state };
}

/** A DB whose single-row read rejects — a transient D1 failure. */
function throwingKeyDb(): Database {
	return {
		select: () => ({
			from: () => ({ where: () => ({ get: async () => Promise.reject(new Error('D1 unavailable')) }) })
		})
	} as unknown as Database;
}

const VALID_UNTIL = new Date('2026-09-01T00:00:00Z');

/** Make every verify in a test resolve to the same in-date key. */
function stubValidKey() {
	vi.mocked(verifySupporterKey).mockResolvedValue({
		valid: true,
		login: 'sparky',
		tier: 2,
		expiresAt: VALID_UNTIL
	});
}

// The admin layout runs this on every authenticated admin page request, so the
// cache is what keeps a D1 read + an Ed25519 verify off that path (SONA-118).
// The danger is the mirror image of the settings cache's: a status that outlives
// either the key it was resolved from or the day it was resolved on.
describe('getSupporterKeyStatus — caching', () => {
	// The memo itself is dropped by the file-level afterEach above.
	beforeEach(() => {
		vi.mocked(verifySupporterKey).mockReset();
	});

	it('serves a second resolution for the same day without re-reading or re-verifying', async () => {
		stubValidKey();
		const { db, state } = fakeKeyDb('head.tail');
		const now = new Date('2026-08-25T09:00:00Z');

		const first = await getSupporterKeyStatus(db, now);
		const second = await getSupporterKeyStatus(db, new Date('2026-08-25T18:30:00Z'));

		expect(second).toEqual(first);
		expect(state.reads).toBe(1);
		expect(verifySupporterKey).toHaveBeenCalledTimes(1);
	});

	it('re-resolves across midnight UTC even well inside the TTL', async () => {
		// The day key's whole job: the 60s TTL would otherwise carry a status over
		// the boundary where it changes. An entry written at 23:59:50 on the last
		// covered day would keep saying "expires today" for a key that has already
		// stopped working — so these two calls are 20 seconds apart.
		vi.useFakeTimers();
		stubValidKey();
		const { db, state } = fakeKeyDb('head.tail');

		// 6 days + 10s left of a key that expires end-of-day on the 31st → 7.
		vi.setSystemTime(new Date('2026-08-25T23:59:50Z'));
		const before = await getSupporterKeyStatus(db, new Date('2026-08-25T23:59:50Z'));
		expect(before).toMatchObject({ daysRemaining: 7 });

		vi.setSystemTime(new Date('2026-08-26T00:00:10Z'));
		const after = await getSupporterKeyStatus(db, new Date('2026-08-26T00:00:10Z'));

		expect(after).toMatchObject({ daysRemaining: 6 });
		expect(state.reads).toBe(2);
	});

	it('re-reads after the TTL expires, so a key written by another isolate lands', async () => {
		// clearSupporterKeyStatusCache only reaches the isolate that ran the action;
		// every other one converges on the settings TTL.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-25T09:00:00Z'));
		stubValidKey();
		const { db, state } = fakeKeyDb(null);

		expect(await getSupporterKeyStatus(db, new Date('2026-08-25T09:00:00Z'))).toBeNull();

		state.value = 'head.tail';
		// Still inside the 60s TTL → the stale "no key" answer stands.
		vi.setSystemTime(new Date('2026-08-25T09:00:59Z'));
		expect(await getSupporterKeyStatus(db, new Date('2026-08-25T09:00:59Z'))).toBeNull();

		vi.setSystemTime(new Date('2026-08-25T09:01:01Z'));
		expect(await getSupporterKeyStatus(db, new Date('2026-08-25T09:01:01Z'))).toMatchObject({
			state: 'valid'
		});
		expect(state.reads).toBe(2);
	});

	it('clearSupporterKeyStatusCache() forces the next call to re-read', async () => {
		// What the saveSupporterKey / removeSupporterKey actions rely on.
		stubValidKey();
		const { db, state } = fakeKeyDb(null);
		const now = new Date('2026-08-25T09:00:00Z');
		expect(await getSupporterKeyStatus(db, now)).toBeNull();

		state.value = 'head.tail';
		clearSupporterKeyStatusCache();

		expect(await getSupporterKeyStatus(db, now)).toMatchObject({ state: 'valid' });
		expect(state.reads).toBe(2);
	});

	it('an in-flight resolution does not re-cache its pre-write status', async () => {
		// The operator saves a key in one tab while another admin request is already
		// awaiting the read. That request resolves the OLD row afterwards; caching it
		// would hide the new key for a full TTL, so the clear must win.
		stubValidKey();
		const { db, state } = fakeKeyDb(null);
		const now = new Date('2026-08-25T09:00:00Z');

		const inFlight = getSupporterKeyStatus(db, now);
		clearSupporterKeyStatusCache(); // what saveSupporterKey does mid-flight
		expect(await inFlight).toBeNull();

		state.value = 'head.tail';
		expect(await getSupporterKeyStatus(db, now)).toMatchObject({ state: 'valid' });
		expect(state.reads).toBe(2);
	});

	it('resolves an absent key to null without verifying', async () => {
		const { db } = fakeKeyDb(null);

		expect(await getSupporterKeyStatus(db, new Date('2026-08-25T09:00:00Z'))).toBeNull();
		expect(verifySupporterKey).not.toHaveBeenCalled();
	});

	it('propagates a D1 error and caches nothing, so the next call retries', async () => {
		// The admin layout catches this to degrade just its notice; caching the
		// failure would turn one transient error into a minute of missing notice.
		stubValidKey();
		const now = new Date('2026-08-25T09:00:00Z');
		await expect(getSupporterKeyStatus(throwingKeyDb(), now)).rejects.toThrow('D1 unavailable');

		const { db, state } = fakeKeyDb('head.tail');
		expect(await getSupporterKeyStatus(db, now)).toMatchObject({ state: 'valid' });
		expect(state.reads).toBe(1);
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

	it('writes only the keys it is given — the per-tab save actions rely on this', async () => {
		// The settings page saves one tab at a time (saveSite / saveConnections /
		// saveStorage); a tab's subset must never touch another tab's keys.
		const inserted: Array<{ key: string; value: unknown }> = [];
		const writeDb = {
			select: () => ({ from: () => ({ where: () => ({ get: async () => undefined }) }) }),
			insert: () => ({ values: async (row: { key: string; value: unknown }) => void inserted.push(row) })
		} as unknown as Database;

		await saveSettings(writeDb, { autoResyncEnabled: false, registryOverridesLocal: true });
		expect(inserted).toEqual([
			{ key: 'autoResyncEnabled', value: 'false' },
			{ key: 'registryOverridesLocal', value: 'true' }
		]);
	});
});

// Helpers for the sona/reference profile shown on /art (threePath landing).
describe('parseSonaColors / parseLines', () => {
	it('parses well-formed swatches and drops malformed entries', () => {
		const raw = JSON.stringify([
			{ name: 'Charcoal', hex: '#172937' },
			{ hex: '#FAFAFA' },
			{ name: 'no-hex' },
			'garbage'
		]);
		expect(parseSonaColors(raw)).toEqual([
			{ name: 'Charcoal', hex: '#172937' },
			{ name: '', hex: '#FAFAFA' }
		]);
	});

	it('returns [] for invalid JSON or a non-array', () => {
		expect(parseSonaColors('not json')).toEqual([]);
		expect(parseSonaColors('{"a":1}')).toEqual([]);
	});

	it('splits newline lists into trimmed, non-empty lines', () => {
		expect(parseLines(' one \n\n two\n')).toEqual(['one', 'two']);
	});
});
