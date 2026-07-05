import { getReadDb } from '$lib/server/db';
import { getSettings, settingsFallback } from '$lib/server/settings';
import { withTimeout } from '$lib/server/timeout';
import type { LayoutServerLoad } from './$types';

// This load runs on EVERY public page, so a slow settings read here would stall
// the entire site. Cap it and fall back to cached/default settings.
const SETTINGS_TIMEOUT_MS = 3000;

export const load: LayoutServerLoad = async ({ platform, url }) => {
	// Read-only public path: serve from a read replica (when enabled) and from the
	// per-isolate settings cache, so this is usually a zero-round-trip load.
	const db = getReadDb(platform!.env.DB);
	const settings = await withTimeout(getSettings(db), SETTINGS_TIMEOUT_MS, settingsFallback());
	// The site's own public host, used to attribute the "made with sona" footer
	// badge back to this fork (sona.fast/?ref=<host>). Derived per-request so each
	// fork sends its own domain with no extra config.
	return { settings, host: url.host };
};
