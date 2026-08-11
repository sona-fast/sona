import { eq, sql } from 'drizzle-orm';
import { dev } from '$app/environment';
import { getRawSetting } from '$lib/server/settings';
import { verifySupporterKey } from '$lib/server/supporter-key';
import { isFeatureEnabled, EARLY_ACCESS } from '$lib/early-access';
import { vrAvatars } from '$lib/server/db/schema';
import { cachedProbe } from '$lib/server/nav-gating';
import type { Database } from '$lib/server/db';

type Env = App.Platform['env'];

/** The early-access flag gating who can CREATE/PUBLISH VR avatars (SONA-124).
 * The gate never governs public reads or the admin list — data already on the
 * site is the owner's regardless of key state. Module-local: everything
 * consumes the predicate below, never the raw slug. */
const VR_FEATURE_FLAG = 'vr-avatars';

/**
 * Whether this site may create/publish VR avatars right now: the flag has
 * GA'd, or the stored supporter key verifies. Absent, malformed and expired
 * keys all count as "no key" — only a currently-valid signature unlocks early.
 *
 * This is the ENFORCEMENT predicate: every mutating VR admin action and the
 * model-upload endpoint must refuse when it is false. The gated UI state is
 * presentation on top of it, never a substitute.
 *
 * `env` carries the TEST-ONLY E2E_VR_GATE bypass (see app.d.ts): honored only
 * when set to exactly 'open' AND the build is a dev build (the e2e harness
 * runs `vite dev` — see playwright.config.ts webServer). The `dev` guard
 * compiles the bypass out of production entirely: deploy.yml keeps dashboard
 * vars (keep_vars), so without it a var set on a production deployment would
 * open the pre-GA gate.
 */
export async function vrPublishingEnabled(
	db: Database,
	env?: Env,
	now: Date = new Date()
): Promise<boolean> {
	if (dev && env?.E2E_VR_GATE === 'open') return true;
	// A failed settings read degrades to "no key" rather than throwing the whole
	// page — the GA branch of isFeatureEnabled still opens the gate on time.
	const token = await getRawSetting(db, 'supporterKey').catch(() => null);
	let supporterKeyValid = false;
	if (token) {
		supporterKeyValid = (await verifySupporterKey(token, now)).valid;
	}
	return isFeatureEnabled(VR_FEATURE_FLAG, { supporterKeyValid, now });
}

/** The flag's GA date ('YYYY-MM-DD') while registered, for the gate copy's
 * "opens to everyone" line; null once the registry entry is retired. */
export function vrGaDate(): string | null {
	return EARLY_ACCESS[VR_FEATURE_FLAG] ?? null;
}

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
