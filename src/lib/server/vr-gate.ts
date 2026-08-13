import { eq, sql } from 'drizzle-orm';
import { dev } from '$app/environment';
import { getVerifiedSupporterKey, NO_SUPPORTER_KEY } from '$lib/server/settings';
import { isFeatureEnabled, featureOpenToEveryone, EARLY_ACCESS } from '$lib/early-access';
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
 * Once the flag has GA'd no key can change the answer, so nothing is read at
 * all. Before that the key is memoized per isolate (getVerifiedSupporterKey —
 * see the invariant at its cache site), costing a D1 read plus an Ed25519
 * verify once per TTL rather than once per request, and expiry is still
 * compared against `now` here on every call. Every failure — a D1 error, a key
 * that doesn't verify, anything unexpected out of the memo — is "no key",
 * which denies.
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
	// Past GA (or once the registry entry retires) the flag is open to everyone,
	// and the key cannot change that — so skip the read entirely rather than pay
	// for one on every VR request on every fork for the rest of the product's life.
	if (featureOpenToEveryone(VR_FEATURE_FLAG, now)) return true;
	// A failed read or verify degrades to "no key" rather than throwing the whole
	// page; pre-GA that denies, which is the safe direction. Logged because the
	// operator sees the same gated copy either way — without this, a D1 blip is
	// indistinguishable from a key they never installed.
	const key = await getVerifiedSupporterKey(db).catch((e) => {
		console.error('supporter-key gate read failed:', e instanceof Error ? e.message : e);
		return NO_SUPPORTER_KEY;
	});
	const supporterKeyValid = key.signatureValid && now.getTime() < key.expiresAt;
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
