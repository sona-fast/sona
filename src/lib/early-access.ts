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
 * Label story: the flag key is a slug (e.g. `vr-avatars`), never shown to
 * users. Every registered flag has a message in messages/en.json + ja.json
 * under the by-convention id `early_access_label_<flag with - as _>` (see
 * earlyAccessLabelKey); render-time code resolves that key through paraglide
 * so the label is localized. Adding a flag here without its two message
 * entries fails early-access.test.ts.
 */
export const EARLY_ACCESS: Record<string, string> = {
	// Merged 2026-08-10 → GA a week later (release process above). Delete this
	// entry (and the vrPublishingEnabled gate's reason to exist) at the next
	// release after GA.
	'vr-avatars': '2026-08-17'
};

/**
 * Message id carrying a flag's human-readable, localized display label —
 * `early_access_label_<flag>` with dashes flattened to underscores (message
 * ids can't contain `-`). Render-time code looks this up in the paraglide
 * messages module; the raw flag slug must never be shown to users.
 */
export function earlyAccessLabelKey(flag: string): string {
	return `early_access_label_${flag.replaceAll('-', '_')}`;
}

/** Has the flag's GA date arrived (open to everyone)? Non-registered flags and
 * malformed dates are treated as GA'd. */
function gaReached(gaDate: string, now: Date): boolean {
	const ga = Date.parse(`${gaDate}T00:00:00Z`);
	return Number.isNaN(ga) || now.getTime() >= ga;
}

/**
 * Whether the feature is open to EVERYONE right now: not in the registry, or
 * its GA date has arrived. True here means no supporter key can change the
 * answer — which is what lets an enforcement path skip reading one.
 */
export function featureOpenToEveryone(flag: string, now: Date): boolean {
	const gaDate = EARLY_ACCESS[flag];
	return gaDate === undefined || gaReached(gaDate, now);
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
	return featureOpenToEveryone(flag, now) || supporterKeyValid;
}

/** Flags still inside their early-access window (GA date not yet reached), with
 * their GA dates — what a supporter key is unlocking right now. Render-time
 * code resolves each flag's display label via earlyAccessLabel(flag). */
export function earlyAccessActive(now: Date): Array<{ flag: string; gaDate: string }> {
	return Object.entries(EARLY_ACCESS)
		.filter(([, gaDate]) => !gaReached(gaDate, now))
		.map(([flag, gaDate]) => ({ flag, gaDate }));
}
