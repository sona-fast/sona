import { describe, it, expect, vi } from 'vitest';
import { cachedProbe } from './nav-gating';
import type { Database } from '$lib/server/db';

// cachedProbe's fn only ever receives the db to pass through — a bare token is fine.
const fakeDb = {} as Database;

describe('cachedProbe', () => {
	it('does not cache a probe that resolves after a mid-flight clear()', async () => {
		// The race: a public request's probe starts (reads pre-write truth), a
		// write lands and clear()s, THEN the slow probe resolves. Its stale value
		// must not be cached — or the pill stays wrong for a whole TTL.
		let resolveSlow!: (v: boolean) => void;
		const results = [new Promise<boolean>((r) => (resolveSlow = r)), Promise.resolve(true)];
		const fn = vi.fn(() => results.shift()!);
		const probe = cachedProbe(fn, 60_000);

		const inFlight = probe.probe(fakeDb);
		probe.clear(); // the write's invalidation, while fn is still pending
		resolveSlow(false); // the pre-write truth arrives late
		await expect(inFlight).resolves.toBe(false);

		// A fresh probe must re-query (second fn result: true), not serve the
		// stale false the in-flight probe would have cached without the guard.
		await expect(probe.probe(fakeDb)).resolves.toBe(true);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('caches within the TTL and re-queries after clear()', async () => {
		const fn = vi.fn(async () => true);
		const probe = cachedProbe(fn, 60_000);
		await probe.probe(fakeDb);
		await probe.probe(fakeDb);
		expect(fn).toHaveBeenCalledTimes(1); // second hit served from cache
		probe.clear();
		await probe.probe(fakeDb);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
