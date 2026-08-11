// The header/mobile-nav content-gating flag pair, shared by every load that
// renders the (public) chrome itself: the (public) layout and the homepage
// (+page@ escapes that layout). One helper so the two call sites can't drift
// on posture: both probes are cached per-isolate (stickers.ts/collections.ts),
// ride the caller's timeout bound, and fail OPEN (link shown) on timeout or
// error — a dead link during a transient D1 blip beats hiding sections of a
// healthy site.

import { stickerTabEnabled } from '$lib/server/stickers';
import { collectionsNavEnabled } from '$lib/server/collections';
import { withTimeout } from '$lib/server/timeout';
import type { Database } from '$lib/server/db';

/** Cap for a single nav-content probe on a hot public page. Shared by every
 * load that wraps a probe itself ((paths) layout, /vr) so the bound can't
 * drift between call sites. */
export const PROBE_TIMEOUT_MS = 3000;

/**
 * Short-TTL per-isolate cache scaffold for the nav-content probes, same
 * pattern as the settings cache (settings.ts): each probe runs on every
 * public request via the layout/tab-bar loads, and "does published content
 * exist" changes rarely. Write paths call clear() so the SAME isolate updates
 * immediately; other isolates converge within the TTL. Errors are never
 * cached — a rejection propagates to the caller's fallback and the next
 * request retries.
 */
export function cachedProbe(fn: (db: Database) => Promise<boolean>, ttlMs: number) {
	let cache: { value: boolean; expires: number } | null = null;
	return {
		async probe(db: Database): Promise<boolean> {
			if (cache && cache.expires > Date.now()) return cache.value;
			const value = await fn(db);
			cache = { value, expires: Date.now() + ttlMs };
			return value;
		},
		clear() {
			cache = null;
		}
	};
}

/** [stickersEnabled, collectionsEnabled], each bounded by `timeoutMs`. */
export function navGateFlags(db: Database, timeoutMs: number): Promise<[boolean, boolean]> {
	return Promise.all([
		withTimeout(stickerTabEnabled(db), timeoutMs, true),
		withTimeout(collectionsNavEnabled(db), timeoutMs, true)
	]);
}
