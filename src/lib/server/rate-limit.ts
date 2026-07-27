// Best-effort, per-isolate fixed-window rate limiter (finding M10).
//
// Same limitation as the admin login throttle (admin-auth.ts): Cloudflare
// spreads requests across many isolates, so this blunts a single source hammering
// one isolate, NOT a distributed flood. A hard global cap needs a Cloudflare
// rate-limit rule (or KV/Durable Object). Used here so the unauthenticated
// sticker-download proxy can't be looped cheaply to amplify worker bandwidth.

export class RateLimiter {
	#hits = new Map<string, { count: number; resetAt: number }>();
	#max: number;
	#windowMs: number;
	#nextSweep = 0;

	constructor(max: number, windowMs: number) {
		this.#max = max;
		this.#windowMs = windowMs;
	}

	/** @returns true if the request is allowed, false if the key is over the cap. */
	check(key: string, now: number): boolean {
		// Prune expired windows so entries for one-off IPs don't accumulate for the
		// isolate's lifetime. Amortized to once per window so a flood can't turn this
		// into an O(n) cost per request; live windows are left untouched.
		if (now >= this.#nextSweep) {
			for (const [k, r] of this.#hits) if (now >= r.resetAt) this.#hits.delete(k);
			this.#nextSweep = now + this.#windowMs;
		}
		const rec = this.#hits.get(key);
		if (!rec || now >= rec.resetAt) {
			this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
			return true;
		}
		if (rec.count >= this.#max) return false;
		rec.count += 1;
		return true;
	}

	/** Test-only: clear all recorded hits. */
	reset(): void {
		this.#hits.clear();
	}

	/** Test-only: number of tracked windows (used to assert stale-window eviction). */
	get size(): number {
		return this.#hits.size;
	}
}
