import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { APP_NAME } from '$lib/config';
import type { LayoutServerLoad } from './$types';

// Expose the site name to the root layout so the default <title> (and any page
// that doesn't set its own) reflects the configured brand rather than a
// hardcoded one. getSettings is cached per-isolate, so this is cheap.
export const load: LayoutServerLoad = async ({ platform }) => {
	if (!platform?.env.DB) return { siteName: APP_NAME };
	try {
		const db = getDb(platform.env.DB);
		const settings = await getSettings(db);
		return { siteName: settings.siteName };
	} catch {
		return { siteName: APP_NAME };
	}
};
