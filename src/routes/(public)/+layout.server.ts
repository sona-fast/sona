import { getReadDb } from '$lib/server/db';
import { getSettings, settingsFallback, toPublicSettings } from '$lib/server/settings';
import { navGateFlags, PROBE_TIMEOUT_MS } from '$lib/server/nav-gating';
import { withTimeout } from '$lib/server/timeout';
import type { LayoutServerLoad } from './$types';

// This load runs on EVERY public page, so a slow settings read here would stall
// the entire site. Cap it and fall back to cached/default settings.
const SETTINGS_TIMEOUT_MS = 3000;

export const load: LayoutServerLoad = async ({ platform, url }) => {
	// Read-only public path: serve from a read replica (when enabled) and from
	// the per-isolate settings + nav-probe caches, so a warm isolate does this
	// load with zero round-trips.
	const db = getReadDb(platform!.env.DB);
	// Nav gating: the header and mobile nav hide the Stickers/Collections links
	// while those sections have no published content (same probes as the tab-bar
	// pills; About/Gallery always show). navGateFlags rides the shared probe cap
	// and fails OPEN (link shown) on timeout or error — a dead link during a
	// transient D1 blip beats hiding sections of a healthy site (same rule as
	// the homepage's path-card probes).
	const [settings, [stickersEnabled, collectionsEnabled]] = await Promise.all([
		withTimeout(getSettings(db), SETTINGS_TIMEOUT_MS, settingsFallback()),
		navGateFlags(db, PROBE_TIMEOUT_MS)
	]);
	// Every public load returns settings through toPublicSettings, which narrows
	// them to the public allowlist. That withholds the /ai override text: this
	// load rides EVERY public page, and a fork that turned /ai off must not
	// still ship its retired copy to every visitor.
	const publicSettings = toPublicSettings(settings);
	// The site's own public host, used to attribute the "made with sona" footer
	// badge back to this fork (sona.fast/?ref=<host>). Derived per-request so each
	// fork sends its own domain with no extra config.
	return { settings: publicSettings, host: url.host, stickersEnabled, collectionsEnabled };
};
