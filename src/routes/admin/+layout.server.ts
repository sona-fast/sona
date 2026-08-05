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

export const load: LayoutServerLoad = async ({ platform }) => {
	if (!platform?.env.DB) return EMPTY;

	try {
		const db = getDb(platform.env.DB);
		const settings = await getSettings(db);
		const renv = await resolveRegistryEnv(db, platform.env);
		// Expiring-soon nudge (SONA-114): surfaced on every admin page, not just
		// Settings — an operator who never opens Settings would otherwise get no
		// warning before early-access features disappear. Only the display fields
		// leave the server; the token stays out of the layout payload.
		const supporterToken = (await getRawSetting(db, 'supporterKey')) ?? '';
		const supporterKey = await resolveSupporterKeyStatus(supporterToken, new Date());
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
			supporterKeyNotice: supporterKey?.expiringSoon
				? { daysRemaining: supporterKey.daysRemaining, validUntil: supporterKey.validUntil }
				: null
		};
	} catch {
		return EMPTY;
	}
};
