/**
 * Early-access feature registry.
 *
 * A feature ships in an early-access window: supporters (valid supporter key)
 * get it the day it lands; everyone else gets it on its GA date, a week later.
 *
 * Release process:
 *  - When a feature is released early-access, add `flag → gaDate` here, where
 *    gaDate = release date + 7 days ('YYYY-MM-DD'). Gate the feature on
 *    `isFeatureEnabled(flag, …)`.
 *  - At the NEXT release, delete the entry (its GA date has passed, so it's
 *    unconditionally on) and drop the gate. The registry only ever holds the
 *    one or few features currently inside their early-access window.
 *
 * Ships EMPTY — no feature is gated yet; the first pilot lands later.
 *
 * Label story (do before the first real entry): the settings status line
 * interpolates the flag KEY directly, but keys are slugs (e.g. `bulk-export`),
 * not human-readable. Before piloting, either key this registry by display label
 * or add a `label` field per entry and interpolate that instead.
 */
export const EARLY_ACCESS: Record<string, string> = {};

/** Has the flag's GA date arrived (open to everyone)? Non-registered flags and
 * malformed dates are treated as GA'd. */
function gaReached(gaDate: string, now: Date): boolean {
	const ga = Date.parse(`${gaDate}T00:00:00Z`);
	return Number.isNaN(ga) || now.getTime() >= ga;
}

/**
 * Whether a feature is on for this request. A feature not in the registry is
 * never gated (on for everyone); a registered feature is on once its GA date
 * arrives, or immediately for a holder of a valid supporter key.
 */
export function isFeatureEnabled(
	flag: string,
	{ supporterKeyValid, now }: { supporterKeyValid: boolean; now: Date }
): boolean {
	const gaDate = EARLY_ACCESS[flag];
	if (gaDate === undefined) return true;
	if (gaReached(gaDate, now)) return true;
	return supporterKeyValid;
}

/** Flags still inside their early-access window (GA date not yet reached), with
 * their GA dates — what a supporter key is unlocking right now. */
export function earlyAccessActive(now: Date): Array<{ flag: string; gaDate: string }> {
	return Object.entries(EARLY_ACCESS)
		.filter(([, gaDate]) => !gaReached(gaDate, now))
		.map(([flag, gaDate]) => ({ flag, gaDate }));
}
