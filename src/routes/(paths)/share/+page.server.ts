import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

// Content-presence gate (#42): /share's only dynamic content sources are the
// contact rows — Telegram and email (the guidelines/tag copy is static). With
// neither configured the page has no way to actually share anything, so a
// fresh fork 404s here instead of serving a near-empty page. Either source
// alone keeps the page URL-reachable.
export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db);
	if (!settings.contactEmail && !settings.telegramUrl) error(404, 'Not found');
	return {};
};
