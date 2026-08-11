import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { stickerTabEnabled } from '$lib/server/stickers';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db);
	// MobileNav gating, same rule as the (public) layout: hide the Stickers tab
	// while no published pack exists. Fail OPEN on a probe error (this load has
	// no timeout machinery; getSettings already swallows failures the same way).
	const stickersEnabled = await stickerTabEnabled(db).catch(() => true);
	return { settings, stickersEnabled };
};
