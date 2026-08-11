import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vrTabEnabled, clearVrTabCache } from './vr-gate';
import type { Database } from './db';

// vrTabEnabled caches per-isolate with a short TTL (cachedProbe). The avatar
// write paths clear it in their own isolate; TTL expiry is what re-runs the
// probe everywhere else after the first avatar publishes — same pin as
// stickers.test.ts / collections.test.ts.

/** Query-counting fake of the Drizzle chain vrTabEnabled uses
 * (select→from→where→limit→get). */
function fakeProbeDb(row: { one: number } | undefined) {
	const calls = { count: 0 };
	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => ({
						get: async () => {
							calls.count += 1;
							return row;
						}
					})
				})
			})
		})
	} as unknown as Database;
	return { db, calls };
}

describe('vrTabEnabled — cache TTL', () => {
	beforeEach(() => clearVrTabCache());
	afterEach(() => {
		vi.useRealTimers();
		clearVrTabCache();
	});

	it('re-queries after the TTL expires', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { db, calls } = fakeProbeDb({ one: 1 });

		expect(await vrTabEnabled(db)).toBe(true);
		expect(calls.count).toBe(1);

		// Still inside the 60s TTL → cache hit.
		vi.setSystemTime(59_000);
		await vrTabEnabled(db);
		expect(calls.count).toBe(1);

		// Past the TTL → fresh read. This is how OTHER isolates pick up a fork's
		// first published avatar (the writing isolate clears immediately).
		vi.setSystemTime(61_000);
		await vrTabEnabled(db);
		expect(calls.count).toBe(2);
	});

	it('clearVrTabCache forces a fresh read inside the TTL (the write-path hook)', async () => {
		const { db, calls } = fakeProbeDb({ one: 1 });
		expect(await vrTabEnabled(db)).toBe(true);
		expect(calls.count).toBe(1);

		clearVrTabCache();
		await vrTabEnabled(db);
		expect(calls.count).toBe(2);
	});
});
