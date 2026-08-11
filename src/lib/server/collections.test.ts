import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { collectionsNavEnabled, clearCollectionsNavCache } from './collections';
import type { Database } from './db';

// collectionsNavEnabled caches per-isolate with a short TTL. TTL expiry is the
// ONLY mechanism that re-runs the probe after the first collection is created
// (nothing invalidates this cache on create/delete), so it gets its own pin —
// same precedent as settings.test.ts's 're-queries after the TTL expires'.

/** Query-counting fake of the Drizzle chain collectionsNavEnabled uses
 * (select→from→limit→get). */
function fakeProbeDb(row: { one: number } | undefined) {
	const calls = { count: 0 };
	const db = {
		select: () => ({
			from: () => ({
				limit: () => ({
					get: async () => {
						calls.count += 1;
						return row;
					}
				})
			})
		})
	} as unknown as Database;
	return { db, calls };
}

describe('collectionsNavEnabled — cache TTL', () => {
	beforeEach(() => clearCollectionsNavCache());
	afterEach(() => {
		vi.useRealTimers();
		clearCollectionsNavCache();
	});

	it('re-queries after the TTL expires', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { db, calls } = fakeProbeDb({ one: 1 });

		expect(await collectionsNavEnabled(db)).toBe(true);
		expect(calls.count).toBe(1);

		// Still inside the 60s TTL → cache hit.
		vi.setSystemTime(59_000);
		await collectionsNavEnabled(db);
		expect(calls.count).toBe(1);

		// Past the TTL → fresh read. This is how a fork's first collection
		// eventually shows the nav link without a redeploy.
		vi.setSystemTime(61_000);
		await collectionsNavEnabled(db);
		expect(calls.count).toBe(2);
	});
});
