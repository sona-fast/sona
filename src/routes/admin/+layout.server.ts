import { getDb } from '$lib/server/db';
import { getSettings, getRawSetting } from '$lib/server/settings';
import { isRegistryEnabled, resolveRegistryEnv } from '$lib/server/registry';
import { isObservabilityEnabled } from '$lib/server/metrics';
import { resolveSupporterKeyStatus } from '$lib/server/supporter-key';
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
		const [renv, supporterToken] = await Promise.all([
			resolveRegistryEnv(db, platform.env),
			locals.admin ? getRawSetting(db, 'supporterKey') : null
		]);
		const supporterKey = await resolveSupporterKeyStatus(supporterToken ?? '', new Date());
		// Dismissal is a cookie keyed on validUntil PLUS a phase ('early' = days
		// 7..4, 'final' = last 3 days): dismissing during the early phase re-shows
		// the notice once the final days start, and a re-minted key (new
		// validUntil) always warns afresh. SSR reads the cookie so the banner
		// renders in its final state — no post-hydration layout shift.
		const phase = supporterKey && supporterKey.daysRemaining <= 3 ? 'final' : 'early';
		const dismissValue = supporterKey ? `${supporterKey.validUntil}:${phase}` : '';
		const dismissed = cookies.get('supporterNoticeDismissed') === dismissValue;
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
