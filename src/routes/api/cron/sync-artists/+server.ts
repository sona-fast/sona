import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import {
	isRegistryEnabled,
	resolveRegistryEnv,
	RegistryRefusalError,
	RegistrySyncError
} from '$lib/server/registry';
import { syncArtists, describeSync } from '$lib/server/artist-sync';
import { requireCronSecret } from '$lib/server/cron-auth';
import { cleanMessage, recordJobRun, schedule } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

// POST /api/cron/sync-artists
//
// Machine-to-machine endpoint that pulls artist updates from the shared registry
// and stamps global_id onto local-only artists that match. Like the Telegram
// re-sync cron, it's exempt from the admin gate in hooks and authenticates with
// a shared secret: `Authorization: Bearer <CRON_SECRET>`. Idempotent + bounded;
// the registry is never on a render path, so this is purely a background refresh.
export const POST: RequestHandler = async ({ request, platform }) => {
	const env = platform?.env;
	requireCronSecret(request, env);

	const db = getDb(env!.DB);
	const renv = await resolveRegistryEnv(db, env);
	if (!isRegistryEnabled(renv))
		error(503, 'Registry is not configured (set the REGISTRY_API_KEY secret or connect in admin Settings).');

	const settings = await getSettings(db);
	// Observability (issue #6): heartbeat for the background-jobs panel. A thrown
	// error records a failed run before propagating, so the dashboard reflects it.
	let summary;
	try {
		summary = await syncArtists(db, renv, settings);
	} catch (e) {
		schedule(platform, recordJobRun(db, 'sync-artists', 'failed',
			e instanceof Error ? e.message : 'sync failed'));
		// A refusal from (or in front of) the registry is an upstream fault with a
		// known reason. Rethrowing it turned into SvelteKit's generic 500 "Internal
		// Error", so the workflow log showed nothing to act on and the real cause
		// only lived in job_run — for five days, once. Hand the reason back as JSON
		// instead: the workflow prints the body, and 502 keeps the run red. Anything
		// else (a D1 failure) is still our bug and still propagates as a 500.
		if (e instanceof RegistrySyncError) {
			// The reason quotes an upstream body, and the sync workflow prints this
			// response into a PUBLIC Actions log — so it goes through the same
			// redaction (and 300-char clamp) that job_run.detail gets.
			return json(
				{
					ok: false,
					error: cleanMessage(e.message),
					...(e instanceof RegistryRefusalError ? { upstreamStatus: e.httpStatus } : {})
				},
				{ status: 502 }
			);
		}
		throw e;
	}
	schedule(platform, recordJobRun(db, 'sync-artists', 'ok', describeSync(summary)));
	// Named field by field, not spread: every last* reason quotes an upstream body
	// verbatim, and those belong in the job_run detail (which redacts them) rather
	// than in a response the workflow log prints. An allowlist keeps a field added to
	// SyncSummary later out of the body until someone puts it here on purpose. The
	// counters still say the run degraded. (json() drops undefined, so a run that
	// wasn't skipped has no `skipped` key.)
	return json({
		ok: true,
		skipped: summary.skipped,
		refreshed: summary.refreshed,
		linked: summary.linked,
		scanned: summary.scanned,
		searchFailed: summary.searchFailed,
		rateLimited: summary.rateLimited,
		deltaFailed: summary.deltaFailed
	});
};
