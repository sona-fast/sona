import { getRawSetting } from '$lib/server/settings';
import { verifySupporterKey } from '$lib/server/supporter-key';
import { isFeatureEnabled, EARLY_ACCESS } from '$lib/early-access';
import type { Database } from '$lib/server/db';

/** The early-access flag gating who can CREATE/PUBLISH VR avatars (SONA-124).
 * The gate never governs public reads or the admin list — data already on the
 * site is the owner's regardless of key state. */
export const VR_FEATURE_FLAG = 'vr-avatars';

/**
 * Whether this site may create/publish VR avatars right now: the flag has
 * GA'd, or the stored supporter key verifies. Absent, malformed and expired
 * keys all count as "no key" — only a currently-valid signature unlocks early.
 *
 * This is the ENFORCEMENT predicate: every mutating VR admin action and the
 * model-upload endpoint must refuse when it is false. The gated UI state is
 * presentation on top of it, never a substitute.
 */
export async function vrPublishingEnabled(db: Database, now: Date = new Date()): Promise<boolean> {
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
