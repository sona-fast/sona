import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db);
	return { settings };
};
