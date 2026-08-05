import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { parseBackfillParams, runAnimatedBackfill } from '$lib/server/backfill-animated';
import type { RequestHandler } from './$types';

// POST /api/stickers/backfill-animated[?limit=N&afterId=ID]  (admin-only via hooks)
//
// Admin-session entry point for the is_animated backfill; the logic (and the
// machine-to-machine twin at /api/cron/backfill-animated, which the
// backfill-animated.yml workflow drives) lives in $lib/server/backfill-animated.
export const POST: RequestHandler = async ({ platform, url, fetch }) => {
	const db = getDb(platform!.env.DB);
	const { limit, afterId } = parseBackfillParams(url);
	return json(await runAnimatedBackfill({ db, fetchFn: fetch, origin: url.origin, limit, afterId }));
};
