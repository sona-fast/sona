/**
 * Early-access feature registry.
 *
 * A feature ships in an early-access window: supporters (valid supporter key)
 * get it the day it lands; everyone else gets it on its GA date, a week later.
 *
 * Release process:
 *  - When a feature is released early-access, add its entry here: `gaDate` =
 *    release date + 7 days ('YYYY-MM-DD'), and `label` = the flag's paraglide
 *    message function, statically referenced (add the by-convention id from
 *    earlyAccessLabelKey to messages/en.json + ja.json, then reference it as
 *    `m.early_access_label_<flag>` — re-adding
 *    `import * as m from '$lib/paraglide/messages';` at the top of this file,
 *    which the empty registry doesn't currently need). Gate the feature on
 *    `isFeatureEnabled(flag, …)`.
 *  - At the NEXT release, delete the entry (its GA date has passed, so it's
 *    unconditionally on) and drop the gate. The registry only ever holds the
 *    one or few features currently inside their early-access window.
 *
 * Label story: the flag key is a slug (e.g. `vr-avatars`), never shown to
 * users — render-time code shows the entry's `label`. The label must be a
 * STATIC reference to its message function, never a computed lookup into the
 * messages namespace: a computed key defeats tree-shaking and pins the entire
 * message catalog into every route that renders a label (SONA-169;
 * scripts/check-catalog-pinning.mjs fails CI on a re-pin). Registering a flag
 * without its two message entries fails early-access.test.ts.
 */

/** A flag's localized label message — paraglide's message-function shape. */
export type EarlyAccessLabel = (
	inputs?: Record<string, never>,
	options?: { locale?: 'en' | 'ja' }
) => string;

export const EARLY_ACCESS: Record<string, { gaDate: string; label: EarlyAccessLabel }> = {
	// Empty: no feature is currently inside its early-access window. The first
	// entry was 'vr-avatars' (GA'd 2026-08-17, retired per the release process
	// above — SONA-157). Shape of an entry, for the next release:
	// 'vr-avatars': { gaDate: '2026-08-17', label: m.early_access_label_vr_avatars }
};

/**
 * Message id carrying a flag's human-readable, localized display label —
 * `early_access_label_<flag>` with dashes flattened to underscores (message
 * ids can't contain `-`). This is the author-facing naming convention for the
 * message id a registry entry's `label` statically references; it's enforced
 * only by early-access.test.ts. The ja.json half of that check is the only
 * guard against a missing Japanese label — paraglide compiles from en, so a
 * missing ja translation silently falls back to English.
 */
export function earlyAccessLabelKey(flag: string): string {
	return `early_access_label_${flag.replaceAll('-', '_')}`;
}

/**
 * A flag's localized display label, from its registry entry. Falls back to the
 * raw flag slug when the flag isn't registered — every registered flag carries
 * a label (the type requires it), so the fallback should never render, but a
 * wrong lookup must degrade to something legible rather than throw.
 */
export function earlyAccessLabel(flag: string, options?: { locale?: 'en' | 'ja' }): string {
	// Object.hasOwn: a bare bracket lookup reaches Object.prototype for flags
	// like 'constructor' and would throw instead of falling back to the slug.
	return Object.hasOwn(EARLY_ACCESS, flag) ? EARLY_ACCESS[flag].label({}, options) : flag;
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
	// No Object.hasOwn needed here (unlike earlyAccessLabel): a prototype-named
	// flag yields entry.gaDate === undefined, and gaReached treats the NaN parse
	// as GA'd — the right answer for any unregistered flag.
	const entry = EARLY_ACCESS[flag];
	return entry === undefined || gaReached(entry.gaDate, now);
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
		.filter(([, entry]) => !gaReached(entry.gaDate, now))
		.map(([flag, entry]) => ({ flag, gaDate: entry.gaDate }));
}
