import { dev } from '$app/environment';
import { getVerifiedSupporterKey, NO_SUPPORTER_KEY } from '$lib/server/settings';
import { isFeatureEnabled, featureOpenToEveryone, EARLY_ACCESS } from '$lib/early-access';
import { formatDate } from '$lib/index';
import type { Database } from '$lib/server/db';

type Env = App.Platform['env'];

/** The early-access flag gating who can ADD and CHANGE commission ledger
 * entries (SONA-236). It never governs reading or deleting them: the entries
 * are the owner's private data whatever their key says. Module-local, like the
 * retired VR gate's: everything consumes the predicate below, never the slug. */
const COMMISSION_FEATURE_FLAG = 'commission-ledger';

/**
 * Whether this site may create and update ledger entries right now: the flag
 * has GA'd, or the stored supporter key verifies and hasn't expired.
 *
 * This is the ENFORCEMENT predicate: the create and update actions refuse with
 * 403 when it is false. Hidden controls on the pages are presentation on top of
 * it, never a substitute.
 *
 * Past the GA date no key can change the answer, so nothing is read. Before it,
 * the key comes from the per-isolate memo in getVerifiedSupporterKey, and
 * expiry is compared against `now` here on every call. Every failure (a D1
 * error, a key that doesn't verify, a verifier that throws) counts as no key,
 * which denies.
 *
 * `env` carries the TEST-ONLY E2E_COMMISSION_GATE bypass (see app.d.ts): honored
 * only when it is exactly 'open' AND the build is a dev build (the e2e harness
 * runs `vite dev`). The `dev` guard compiles the bypass out of production:
 * deploy.yml keeps dashboard vars, so without it a var set on a production
 * deployment would open the pre-GA gate.
 */
export async function commissionLedgerEnabled(
	db: Database,
	env?: Env,
	now: Date = new Date()
): Promise<boolean> {
	if (dev && env?.E2E_COMMISSION_GATE === 'open') return true;
	if (featureOpenToEveryone(COMMISSION_FEATURE_FLAG, now)) return true;
	// Logged because the owner sees the same gated copy either way: without it, a
	// D1 blip looks exactly like a key they never installed.
	const key = await getVerifiedSupporterKey(db).catch((e) => {
		console.error('supporter-key gate read failed:', e instanceof Error ? e.message : e);
		return NO_SUPPORTER_KEY;
	});
	const supporterKeyValid = key.signatureValid && now.getTime() < key.expiresAt;
	return isFeatureEnabled(COMMISSION_FEATURE_FLAG, { supporterKeyValid, now });
}

/** The flag's GA date ('YYYY-MM-DD') while it's registered, for the "opens to
 * everyone on" copy; null once the registry entry retires. The date string,
 * not the entry: the entry is `{ gaDate, label }` and would render as
 * "[object Object]". */
export function commissionLedgerGaDate(): string | null {
	return Object.hasOwn(EARLY_ACCESS, COMMISSION_FEATURE_FLAG)
		? EARLY_ACCESS[COMMISSION_FEATURE_FLAG].gaDate
		: null;
}

/** What the ledger pages need to show the gate: whether adding and changing
 * entries is open, and the GA date as the UI formats dates. */
export async function commissionGateView(
	db: Database,
	env?: Env,
	now: Date = new Date()
): Promise<{ open: boolean; gaDate: string | null }> {
	const gaDate = commissionLedgerGaDate();
	return {
		open: await commissionLedgerEnabled(db, env, now),
		gaDate: gaDate ? formatDate(gaDate) : null
	};
}
