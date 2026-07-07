import { json, error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { deleteOrphansAll, collectReferencedUrls } from '$lib/server/storage';
import { requireCronSecret } from '$lib/server/cron-auth';
import { recordJobRun, schedule } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

// POST /api/cron/cleanup-orphans[?dryRun=1]
//
// Machine-to-machine endpoint (GitHub Actions cron, see cleanup-orphans.yml)
// that deletes stored objects no URL in the database references — canceled or
// refreshed uploads leave orphans because /api/upload stores bytes before any
// D1 row exists. Like the other /api/cron/* endpoints it's exempt from the
// admin gate in hooks and authenticates with `Authorization: Bearer
// <CRON_SECRET>`.
//
// Only objects older than 48h are touched, so anything an admin is mid-way
// through uploading or wiring up can never be swept. `?dryRun=1` reports what
// would be deleted ({ wouldDelete }) without deleting anything.
const ORPHAN_MIN_AGE_MS = 48 * 60 * 60 * 1000;

export const POST: RequestHandler = async ({ request, url, platform }) => {
	const env = platform?.env;
	requireCronSecret(request, env);

	// Same reasoning as the Settings "Clear cache" action: dev shares the live
	// UploadThing token, so "orphans" judged against a dev DB may still be
	// referenced by prod. The scheduler never targets dev, but fail closed anyway.
	if (dev) {
		error(400, 'Orphan cleanup is disabled in dev — it would delete from the live UploadThing account that production uses.');
	}

	const db = getDb(env!.DB);
	const settings = await getSettings(db);
	const referenced = await collectReferencedUrls(db, settings);
	const dryRunParam = url.searchParams.get('dryRun');
	const dryRun = dryRunParam === '1' || dryRunParam === 'true';
	// abortOnEmptyKeepSet: this endpoint runs unattended, so if NO referenced
	// URL resolves to a stored key (broken/empty reference set — everything
	// would be judged an orphan), the provider skips deletion and the anomaly
	// is reported in `skipped` instead of wiping the store.
	const result = await deleteOrphansAll(env, settings, referenced, {
		olderThan: new Date(Date.now() - ORPHAN_MIN_AGE_MS),
		dryRun,
		abortOnEmptyKeepSet: true
	});
	const ok = result.errors.length === 0;
	// Observability (issue #6): heartbeat for the background-jobs panel. Skip dry
	// runs (a probe, not a real sweep). Fire-and-forget so it never delays the run.
	if (!dryRun) {
		schedule(platform, recordJobRun(db, 'cleanup-orphans', ok ? 'ok' : 'failed',
			ok ? `deleted ${result.deleted}` : result.errors.join('; ')));
	}
	// A configured provider failing must fail the workflow run, which only
	// checks the HTTP status — so real errors return 500, not a green ok:true.
	return json(
		{
			ok,
			...(dryRun ? { wouldDelete: result.deleted } : { deleted: result.deleted }),
			skipped: result.skipped,
			errors: result.errors
		},
		{ status: ok ? 200 : 500 }
	);
};
