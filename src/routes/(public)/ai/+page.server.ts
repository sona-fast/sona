import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

// The /ai disclosure page is a per-fork toggle, DEFAULT ON (SONA-167). Like
// every visibility rule on this site the gate lives in the server load, not
// the client: a fork that turned the page off 404s the route itself, the same
// plain not-found a nonexistent path gets — the footer link disappears with it
// (Footer renders it conditionally from the same setting).
//
// The override text is returned HERE, not by the (public) layout: the layout
// payload rides every public page, and a disabled page's text must not keep
// shipping to every visitor. Same cached settings read the layout uses, so
// this adds no D1 round-trip on a warm isolate.
export const load: PageServerLoad = async ({ parent, platform }) => {
	const { settings } = await parent();
	if (!settings.aiPageEnabled) throw error(404, 'Not found');
	const db = getReadDb(platform!.env.DB);
	const { aiPageText, aiPageUpdatedAt } = await getSettings(db);
	return { aiPageText, aiPageUpdatedAt };
};
