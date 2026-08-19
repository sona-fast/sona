import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { APP_NAME } from '$lib/config';
import type { LayoutServerLoad } from './$types';

// Expose the site name to the root layout so the default <title> (and any page
// that doesn't set its own) reflects the configured brand rather than a
// hardcoded one. getSettings is cached per-isolate, so this is cheap.
export const load: LayoutServerLoad = async ({ platform }) => {
	// Both fallbacks below carry rssFeedEnabled: true, the setting's own default.
	// The autodiscovery tag fails OPEN for the same reason the footer link does
	// (navGateFlags' documented policy): a stray <link> during a read blip costs
	// a reader one 404, while the route itself gates on a raw, fail-closed read.
	if (!platform?.env.DB) return { siteName: APP_NAME, rssFeedEnabled: true };
	try {
		const db = getDb(platform.env.DB);
		const settings = await getSettings(db);
		return { siteName: settings.siteName, rssFeedEnabled: settings.rssFeedEnabled };
	} catch {
		return { siteName: APP_NAME, rssFeedEnabled: true };
	}
};
