import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { APP_NAME } from '$lib/config';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform }) => {
	if (!platform?.env.DB) return { adminAvatarUrl: null, siteName: APP_NAME, ownerName: '' };

	try {
		const db = getDb(platform.env.DB);
		const settings = await getSettings(db);
		return {
			adminAvatarUrl: settings.adminAvatarUrl || null,
			siteName: settings.siteName,
			ownerName: settings.ownerName
		};
	} catch {
		return { adminAvatarUrl: null, siteName: APP_NAME, ownerName: '' };
	}
};
