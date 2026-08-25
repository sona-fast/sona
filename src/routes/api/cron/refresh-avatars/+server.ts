import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { refreshArtistAvatars, healOwnerAvatar, type OwnerAvatarHeal } from '$lib/server/avatar';
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

	// An EXPLICIT batch=0 means "owner heal only, no artist work", and is how the
	// workflow calls a fork that never opted into artist refreshing. It has to be
	// distinguishable from an ABSENT param, which still means "use the default":
	// treating both as 0 would make a bare call do nothing, and treating both as
	// the default would start refreshing 25 artists on forks that deliberately
	// opted out. The owner heal does not run on this dial — it is the fork's own
	// avatar, not a batch of other people's.
	const rawParam = url.searchParams.get('batch');
	const raw = Number(rawParam);
	const explicitZero = rawParam !== null && Number.isFinite(raw) && Math.floor(raw) === 0;
	const batch = explicitZero
		? 0
		: Number.isFinite(raw) && raw > 0
			? Math.min(Math.floor(raw), MAX_BATCH)
			: DEFAULT_BATCH;

	const db = getDb(env!.DB);
	const settings = await getSettings(db);

	// The owner avatar, which nothing used to retry: a failed re-host leaves
	// settings holding a source hotlink, and the only thing that ever tried again
	// was the operator happening to save the site tab.
	//
	// It goes FIRST, before the artist batch, because of the real bound on this
	// request described above — the workflow's `curl --max-time`. A 50-artist
	// batch of Twitter guest-token timeouts can burn that whole window; the
	// client disconnect then cancels the request mid-run, and anything queued
	// behind the batch never happens. For the heal that would not be an
	// occasional miss but a permanent one, since mode 'oldest' never drains and
	// every day's run would die at the same place. What keeps one owner profile
	// lookup from failing an otherwise good artist run is the try/catch below,
	// which does that job from either position. Heal-only, so a healthy fork pays
	// one settings read (getRawSettings fetches both owner keys in a single
	// query, and the pre-write re-read is unreachable on that path) and no
	// network call at all.
	let ownerAvatar: OwnerAvatarHeal = 'skipped';
	try {
		ownerAvatar = await healOwnerAvatar(db, { env, settings, origin: url.origin });
	} catch (e) {
		// Never fails the run — but it must not report as a healthy fork either.
		// 'unresolved' is exactly what a throw leaves behind (we tried, the owner
		// is still on someone else's host), and it is the only part of this that
		// reaches the operator: the warn goes to a log nobody reads, while the
		// heartbeat below is on their background-jobs panel.
		ownerAvatar = 'unresolved';
		console.warn(`[avatar] owner heal threw: ${e instanceof Error ? e.message : String(e)}`);
	}

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
	// Operator wording, not the function's. "still unresolved" would point them at
	// their Bluesky profile, but the dominant failure is the other half — the
	// profile resolves and the copy to storage fails. Reporting the ACTION rather
	// than the state keeps it true in the branches where nothing is stranded on a
	// third-party host at all: a handle that changed mid-run, and a fork whose
	// owner has a handle but no picture anywhere. "self-hosted" is the phrase the
	// admin artists panel already ships ("All avatars are already self-hosted").
	const ownerNote =
		ownerAvatar === 'skipped'
			? ''
			: `, owner avatar ${ownerAvatar === 'healed' ? 'now self-hosted' : 'not re-hosted this run'}`;
	schedule(platform, recordJobRun(db, 'refresh-avatars', 'ok',
		`refreshed ${result.refreshed}/${result.processed}, ${result.remaining} remaining${ownerNote}`));
	return json({ ...result, ownerAvatar });
};
