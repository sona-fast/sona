// Collections nav gating: the one probe the header/mobile nav use to decide
// whether to link /collections. Lives here (not in the page load) so every nav
// surface shares a single notion of "the Collections section has content".

import { sql } from 'drizzle-orm';
import { collections } from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';

// Short-TTL in-memory cache, same pattern as the settings cache (settings.ts):
// the probe runs on every public request via the layout loads, and "does a
// collection exist" changes rarely. Isolates converge within the TTL after a
// create/delete. Errors are never cached — the caller's fail-open fallback
// handles them and the next request retries.
const COLLECTIONS_NAV_TTL_MS = 60_000;
let collectionsNavCache: { value: boolean; expires: number } | null = null;

export function clearCollectionsNavCache() {
	collectionsNavCache = null;
}

/**
 * Whether the top-level nav shows the Collections link: at least one
 * collection row exists. This mirrors the /collections PAGE's own empty-state
 * predicate exactly — that page lists every collection (a collection whose
 * images are all unpublished still renders, with a zero artwork count), so
 * bare row existence is the right probe here, NOT "has published images".
 * SELECT 1 … LIMIT 1 existence probe, cached per-isolate, same shape as
 * vrTabEnabled / stickerTabEnabled.
 */
export async function collectionsNavEnabled(db: Database): Promise<boolean> {
	if (collectionsNavCache && collectionsNavCache.expires > Date.now()) {
		return collectionsNavCache.value;
	}
	const row = await db.select({ one: sql<number>`1` }).from(collections).limit(1).get();
	const value = row !== undefined;
	collectionsNavCache = { value, expires: Date.now() + COLLECTIONS_NAV_TTL_MS };
	return value;
}
