import { getDb } from '$lib/server/db';
import { getSettings, getRawSetting } from '$lib/server/settings';
import { isRegistryEnabled, resolveRegistryEnv } from '$lib/server/registry';
import { isObservabilityEnabled } from '$lib/server/metrics';
import { resolveSupporterKeyStatus, EXPIRY_FINAL_DAYS } from '$lib/server/supporter-key';
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
		// getRawSetting propagates D1 errors (getSettings self-catches); a failed
		// read must degrade only the notice, not drop the chrome to EMPTY.
		const [renv, supporterToken] = await Promise.all([
			resolveRegistryEnv(db, platform.env),
			locals.admin ? getRawSetting(db, 'supporterKey').catch(() => null) : null
		]);
		const supporterKey = await resolveSupporterKeyStatus(supporterToken ?? '', new Date());
		// Dismissal is a cookie keyed on validUntil PLUS a phase ('early' = days
		// 7..4, 'final' = last 3 days): dismissing during the early phase re-shows
		// the notice once the final days start, and a re-minted key (new
		// validUntil) always warns afresh. SSR reads the cookie so the banner
		// renders in its final state — no post-hydration layout shift.
		const phase = supporterKey && supporterKey.daysRemaining <= EXPIRY_FINAL_DAYS ? 'final' : 'early';
		const dismissValue = supporterKey ? `${supporterKey.validUntil}:${phase}` : '';
		// Phases are ordered: a 'final' dismissal for the same validUntil also
		// suppresses the early phase (a stale final cookie must not re-warn if a
		// request lands a phase earlier), while an early dismissal never covers
		// the final phase.
		const cookie = cookies.get('supporterNoticeDismissed');
		// The !!supporterKey guard is redundant today (a null status never renders
		// the notice) but deliberate: without it a cookie of "undefined:final"
		// would satisfy the comparison, an attacker-suppliable value that a later
		// change to the notice condition could make meaningful. Keep it.
		const dismissed =
			!!supporterKey && (cookie === dismissValue || cookie === `${supporterKey.validUntil}:final`);
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
				// Whether to warn is decided here, in UTC (expiringSoon); how many days
				// the notice prints is recounted in the viewer's zone from this instant
				// (SONA-119), so it can't contradict the settings card's countdown.
				? { expiresAtMs: supporterKey.expiresAtMs, dismissValue }
				: null
		};
	} catch {
		return EMPTY;
	}
};
