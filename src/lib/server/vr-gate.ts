import { eq, sql } from 'drizzle-orm';
import { vrAvatars } from '$lib/server/db/schema';
import { cachedProbe } from '$lib/server/nav-gating';
import type { Database } from '$lib/server/db';

// The SONA-124 early-access publishing gate (vrPublishingEnabled / vrGaDate)
// lived here until the 'vr-avatars' flag GA'd on 2026-08-17 and its registry
// entry retired (SONA-157). Creating/publishing VR avatars is now
// unconditionally on; only the content-driven tab probe below remains.

// Short-TTL per-isolate cache — see cachedProbe (nav-gating.ts) for the
// rationale; the avatar write paths (vr-avatars.ts) clear it.
const vrTabProbe = cachedProbe(async (db) => {
	const row = await db
		.select({ one: sql<number>`1` })
		.from(vrAvatars)
		.where(eq(vrAvatars.published, true))
		.limit(1)
		.get();
	return row !== undefined;
}, 60_000);

export function clearVrTabCache() {
	vrTabProbe.clear();
}

/**
 * Whether the public VR Avatars tab shows: at least one PUBLISHED avatar
 * exists (with zero, the tab and the empty /vr grid behind it stay
 * undiscoverable). Shared by the gallery and stickers loads so the tab bars
 * can never disagree. SELECT 1 … LIMIT 1 — an existence probe, not a COUNT
 * over the table; cached per-isolate, run inside the callers' Promise.all
 * (these are hot public pages).
 */
export async function vrTabEnabled(db: Database): Promise<boolean> {
	return vrTabProbe.probe(db);
}
