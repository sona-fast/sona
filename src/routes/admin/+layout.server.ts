import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform }) => {
	if (!platform?.env.DB) return { adminAvatarUrl: null };

	try {
		const db = getDb(platform.env.DB);
		const settings = await getSettings(db);
		return { adminAvatarUrl: settings.adminAvatarUrl || null };
	} catch {
		return { adminAvatarUrl: null };
	}
};
