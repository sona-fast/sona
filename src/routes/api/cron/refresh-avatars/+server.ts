import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { refreshArtistAvatars } from '$lib/server/avatar';
import { requireCronSecret } from '$lib/server/cron-auth';
import { recordJobRun, schedule } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

// POST /api/cron/refresh-avatars?batch=<N>
//
// Machine-to-machine endpoint for the scheduled avatar refresh (issue #187, the
// AVATAR_REFRESH_BATCH cron designed in #148). It re-resolves + re-hosts a bounded
// batch of artist avatars, rotating oldest-first (rows never refreshed come first),
// so re-hosted copies track the artist's current picture as they change it.
//
// Like the other /api/cron/* endpoints this has NO admin session — it's exempted
// from the admin gate in hooks.server.ts and authenticates with a shared secret:
//   Authorization: Bearer <CRON_SECRET>
// See resync-telegram for the pattern. The batch size comes from ?batch=<N> (set
// by the workflow from the AVATAR_REFRESH_BATCH repo var); it's clamped to a
// ceiling sized against the REAL bound on this request: the workflow's curl
// --max-time. When curl gives up, the client disconnect cancels the request
// mid-run AND silently skips both recordJobRun heartbeats below — the dashboard
// never hears the run happened. Sizing: a typical artist takes ~1-2s (profile
// lookup + image download + store), so 50 finishes in a couple of minutes; the
// worst case is ~28s/artist (the Twitter guest-token flow timing out through
// every fallback), which is why the workflow's ceiling is a generous 900s — a
// pathological all-timeout batch can still exceed it, and the clamp keeps that
// window small. When a backlog remains (result.remaining > 0) the next
// scheduled run continues.
const DEFAULT_BATCH = 25;
const MAX_BATCH = 50;

export const POST: RequestHandler = async ({ request, platform, url }) => {
	const env = platform?.env;

	// Auth: constant secret in an Authorization: Bearer header. If CRON_SECRET isn't
	// configured the endpoint can't be authenticated at all, so refuse rather than
	// run open.
	requireCronSecret(request, env);

	const raw = Number(url.searchParams.get('batch'));
	const batch = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_BATCH) : DEFAULT_BATCH;

	const db = getDb(env!.DB);
	const settings = await getSettings(db);

	// Observability (issue #6): heartbeat for the background-jobs panel. A thrown
	// error records a failed run before propagating, so the dashboard reflects it.
	let result;
	try {
		result = await refreshArtistAvatars(db, {
			env,
			settings,
			origin: url.origin,
			limit: batch,
			mode: 'oldest'
		});
	} catch (e) {
		schedule(platform, recordJobRun(db, 'refresh-avatars', 'failed',
			e instanceof Error ? e.message : 'refresh failed'));
		throw e;
	}
	schedule(platform, recordJobRun(db, 'refresh-avatars', 'ok',
		`refreshed ${result.refreshed}/${result.processed}, ${result.remaining} remaining`));
	return json(result);
};
