import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { requireCronSecret } from '$lib/server/cron-auth';
import { recordJobRun, schedule } from '$lib/server/metrics';
import { parseBackfillParams, runAnimatedBackfill } from '$lib/server/backfill-animated';
import type { RequestHandler } from './$types';

// POST /api/cron/backfill-animated[?limit=N&afterId=ID]
//
// Machine-to-machine twin of /api/stickers/backfill-animated, so the one-time
// is_animated backfill (SONA-123) can be driven fleet-wide from each fork's
// backfill-animated.yml workflow_dispatch — no admin session required.
//
// Like the other /api/cron/* endpoints this is exempt from the admin gate in
// hooks.server.ts and authenticates with the shared secret instead:
//   Authorization: Bearer <CRON_SECRET>
// requireCronSecret fails CLOSED: 503 when no secret is configured, 401 on
// mismatch (constant-time compare). The job itself is idempotent and paged
// (?afterId=<lastId>), so the workflow loops pages until rasters < limit.
export const POST: RequestHandler = async ({ request, platform, url, fetch }) => {
	const env = platform?.env;
	requireCronSecret(request, env);

	const db = getDb(env!.DB);
	const { limit, afterId } = parseBackfillParams(url);

	let result;
	try {
		result = await runAnimatedBackfill({ db, fetchFn: fetch, origin: url.origin, limit, afterId });
	} catch (e) {
		// Heartbeat for the background-jobs panel: a thrown error records a failed
		// run before propagating, so the dashboard reflects it.
		schedule(platform, recordJobRun(db, 'backfill-animated', 'failed',
			e instanceof Error ? e.message : 'backfill failed'));
		throw e;
	}
	schedule(platform, recordJobRun(db, 'backfill-animated', 'ok',
		`${result.updated} updated, ${result.unchanged} unchanged, ${result.failed.length} failed of ${result.rasters} rasters`));
	return json(result);
};
