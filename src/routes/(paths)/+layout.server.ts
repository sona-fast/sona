import { getReadDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { stickerTabEnabled } from '$lib/server/stickers';
import { withTimeout } from '$lib/server/timeout';
import type { LayoutServerLoad } from './$types';

// Same bound as the (public) layout's settings/probe cap: these are hot public
// pages and the probe must never stall them.
const PROBE_TIMEOUT_MS = 3000;

export const load: LayoutServerLoad = async ({ platform }) => {
	// Read-only public path, same posture as the (public) layout: read replica +
	// the per-isolate settings and probe caches.
	const db = getReadDb(platform!.env.DB);
	// MobileNav gating, same rule as the (public) layout: hide the Stickers tab
	// while no published pack exists. The probe rides beside the settings read
	// and fails OPEN (tab shown) on timeout or error — a dead link during a
	// transient D1 blip beats hiding a healthy section.
	const [settings, stickersEnabled] = await Promise.all([
		getSettings(db),
		withTimeout(stickerTabEnabled(db), PROBE_TIMEOUT_MS, true)
	]);
	return { settings, stickersEnabled };
};
