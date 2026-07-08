import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { isRegistryEnabled, resolveRegistryEnv } from '$lib/server/registry';
import { syncArtists } from '$lib/server/artist-sync';
import { requireCronSecret } from '$lib/server/cron-auth';
import { recordJobRun, schedule } from '$lib/server/metrics';
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
		throw e;
	}
	schedule(platform, recordJobRun(db, 'sync-artists', 'ok',
		`refreshed ${summary.refreshed}, linked ${summary.linked}`));
	return json({ ok: true, ...summary });
};
