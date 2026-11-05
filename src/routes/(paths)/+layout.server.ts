import { getDb } from '$lib/server/db';
import { getSettings, toPublicSettings } from '$lib/server/settings';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	// The settings read is intentionally unbounded: getSettings already
	// swallows failures into defaults.
	const settings = await getSettings(db);
	return { settings: toPublicSettings(settings) };
};
