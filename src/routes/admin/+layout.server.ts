import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { isRegistryEnabled } from '$lib/server/registry';
import { APP_NAME } from '$lib/config';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform }) => {
	if (!platform?.env.DB) return { adminAvatarUrl: null, siteName: APP_NAME, ownerName: '', registryEnabled: false };

	try {
		const db = getDb(platform.env.DB);
		const settings = await getSettings(db);
		return {
			adminAvatarUrl: settings.adminAvatarUrl || null,
			siteName: settings.siteName,
			ownerName: settings.ownerName,
			// Exposed to every admin page so the New-artist modal knows up front whether
			// to offer registry search — avoids a fetch-on-open flash-then-hide.
			registryEnabled: isRegistryEnabled(platform.env)
		};
	} catch {
		return { adminAvatarUrl: null, siteName: APP_NAME, ownerName: '', registryEnabled: false };
	}
};
