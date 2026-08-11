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

/** [stickersEnabled, collectionsEnabled], each bounded by `timeoutMs`. */
export function navGateFlags(db: Database, timeoutMs: number): Promise<[boolean, boolean]> {
	return Promise.all([
		withTimeout(stickerTabEnabled(db), timeoutMs, true),
		withTimeout(collectionsNavEnabled(db), timeoutMs, true)
	]);
}
