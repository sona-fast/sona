import { error } from '@sveltejs/kit';
import { inArray } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { siteSettings } from '$lib/server/db/schema';
import type { PageServerLoad } from './$types';

// Content-presence gate (#42): /share's only dynamic content sources are the
// contact rows — Telegram and email (the guidelines/tag copy is static). With
// neither configured the page has no way to actually share anything, so a
// fresh fork 404s here instead of serving a near-empty page. Either source
// alone keeps the page URL-reachable.
//
// The gate reads the two rows directly rather than via getSettings():
// getSettings swallows D1 errors into empty defaults, which would turn a
// transient DB blip into a false 404 on a configured fork. A direct select
// throws on failure instead → 500 "retry" semantics.
export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const rows = await db
		.select({ value: siteSettings.value })
		.from(siteSettings)
		.where(inArray(siteSettings.key, ['contactEmail', 'telegramUrl']));
	if (!rows.some((r) => r.value)) error(404, 'Not found');
	return {};
};
