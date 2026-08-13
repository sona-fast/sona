import { getDb } from '$lib/server/db';
import { getSettings, toPublicSettings } from '$lib/server/settings';
import { stickerTabEnabled } from '$lib/server/stickers';
import { PROBE_TIMEOUT_MS } from '$lib/server/nav-gating';
import { withTimeout } from '$lib/server/timeout';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	// MobileNav gating, same rule as the (public) layout: hide the Stickers tab
	// while no published pack exists. The probe rides beside the settings read
	// and fails OPEN (tab shown) on timeout or error — a dead link during a
	// transient D1 blip beats hiding a healthy section. Only the probe is
	// capped; the settings read is intentionally unbounded, since getSettings
	// already swallows failures into defaults.
	const [settings, stickersEnabled] = await Promise.all([
		getSettings(db),
		withTimeout(stickerTabEnabled(db), PROBE_TIMEOUT_MS, true)
	]);
	return { settings: toPublicSettings(settings), stickersEnabled };
};
