// Collections nav gating: the one probe the header/mobile nav use to decide
// whether to link /collections. Lives here (not in the page load) so every nav
// surface shares a single notion of "the Collections section has content".

import { sql } from 'drizzle-orm';
import { collections } from '$lib/server/db/schema';
import { cachedProbe } from '$lib/server/nav-gating';
import type { Database } from '$lib/server/db';

// Short-TTL per-isolate cache — see cachedProbe (nav-gating.ts) for the
// rationale; the admin collections actions clear it.
const collectionsNavProbe = cachedProbe(async (db) => {
	const row = await db.select({ one: sql<number>`1` }).from(collections).limit(1).get();
	return row !== undefined;
}, 60_000);

export function clearCollectionsNavCache() {
	collectionsNavProbe.clear();
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
	return collectionsNavProbe.probe(db);
}
