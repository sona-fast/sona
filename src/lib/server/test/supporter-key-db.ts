import type { Database } from '$lib/server/db';

// Fakes of the ONE query both supporter-key memos issue — getRawSetting's
// `db.select().from(t).where(...).get()`. Shared by settings.test.ts and
// vr-gate.test.ts so a cache-hit assertion means the same thing at both layers.

/**
 * Resolves to the single stored row. Reads are counted, so a cache hit is
 * observable as "no D1 round-trip"; `value` is mutable so a test can change the
 * row under a warm cache.
 */
export function fakeKeyDb(value: string | null) {
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
export function throwingKeyDb(): Database {
	return {
		select: () => ({
			from: () => ({ where: () => ({ get: async () => Promise.reject(new Error('D1 unavailable')) }) })
		})
	} as unknown as Database;
}
