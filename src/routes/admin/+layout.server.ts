import { getDb } from '$lib/server/db';
import { getSettings, getSupporterKeyStatus } from '$lib/server/settings';
import { isRegistryEnabled, resolveRegistryEnv } from '$lib/server/registry';
import { isObservabilityEnabled } from '$lib/server/metrics';
import { APP_NAME } from '$lib/config';
import type { LayoutServerLoad } from './$types';

const EMPTY = {
	adminAvatarUrl: null,
	siteName: APP_NAME,
	ownerName: '',
	registryEnabled: false,
	observabilityEnabled: false,
	supporterKeyNotice: null
};

export const load: LayoutServerLoad = async ({ platform, locals, cookies }) => {
	if (!platform?.env.DB) return EMPTY;

	try {
		const db = getDb(platform.env.DB);
		const settings = await getSettings(db);
		// Expiring-soon nudge (SONA-114): surfaced on every admin page, not just
		// Settings — an operator who never opens Settings would otherwise get no
		// warning before early-access features disappear. Only the display fields
		// leave the server; the token stays out of the layout payload. Gated on
		// the authenticated session: this load also runs for the auth-exempt
		// routes (/admin/login etc., see hooks.server.ts), which must not spend a
		// D1 read + Ed25519 verify per anonymous hit nor leak key metadata.
		// getSupporterKeyStatus memoizes the resolved status (SONA-118), so neither
		// the read nor the verify is paid on every admin page request. It propagates
		// D1 errors (getSettings self-catches); a failed read must degrade only the
		// notice, not drop the chrome to EMPTY.
		// The operator's own zone (SONA-119) rides in as the third argument,
		// resolved in hooks from the cookie the admin layout writes on every
		// signed-in navigation; absent (no JS, or before the first signed-in page
		// of a browser) it is UTC. The memo underneath caches only zone-independent
		// verified facts, so one operator's zone-rendered dates are never served
		// to another.
		const [renv, supporterKey] = await Promise.all([
			resolveRegistryEnv(db, platform.env),
			locals.admin ? getSupporterKeyStatus(db, new Date(), locals.timeZone).catch(() => null) : null
		]);
		// Dismissal is a cookie keyed on the key's UTC-pinned dismissKey PLUS a
		// phase ('early' = days 7..4, 'final' = last 3 days): dismissing during the
		// early phase re-shows the notice once the final days start, and a re-minted
		// key (new expiry) always warns afresh. SSR reads the cookie so the banner
		// renders in its final state — no post-hydration layout shift. BOTH halves
		// are UTC-pinned rather than read off the displayed date and countdown, so
		// acquiring the tz cookie (or travelling) cannot resurrect a notice the
		// operator already dismissed.
		const dismissValue = supporterKey ? `${supporterKey.dismissKey}:${supporterKey.dismissPhase}` : '';
		// Phases are ordered: a 'final' dismissal for the same key also
		// suppresses the early phase (a stale final cookie must not re-warn if a
		// request lands a phase earlier), while an early dismissal never covers
		// the final phase.
		const cookie = cookies.get('supporterNoticeDismissed');
		// The !!supporterKey guard is redundant today (a null status never renders
		// the notice) but deliberate: without it a cookie of "undefined:final"
		// would satisfy the comparison, an attacker-suppliable value that a later
		// change to the notice condition could make meaningful. Keep it.
		const dismissed =
			!!supporterKey && (cookie === dismissValue || cookie === `${supporterKey.dismissKey}:final`);
		return {
			adminAvatarUrl: settings.adminAvatarUrl || null,
			siteName: settings.siteName,
			ownerName: settings.ownerName,
			// Exposed to every admin page so the New-artist modal knows up front whether
			// to offer registry search — avoids a fetch-on-open flash-then-hide.
			registryEnabled: isRegistryEnabled(renv),
			// Opt-in gate (issue #6): drives whether the sidebar shows the Observability
			// nav item and the Settings → Observability entry.
			observabilityEnabled: isObservabilityEnabled(platform.env),
			supporterKeyNotice: supporterKey?.expiringSoon && !dismissed
				? { daysRemaining: supporterKey.daysRemaining, dismissValue }
				: null
		};
	} catch {
		return EMPTY;
	}
};
