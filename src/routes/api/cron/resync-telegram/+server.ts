import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { isTelegramEnabled } from '$lib/server/telegram';
import { resyncTelegramPacks } from '$lib/server/sticker-import';
import { requireCronSecret } from '$lib/server/cron-auth';
import { recordJobRun, schedule } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

// POST /api/cron/resync-telegram
//
// Machine-to-machine endpoint for a scheduled re-sync of every Telegram-sourced
// sticker pack: pulls in stickers ADDED to a set on Telegram since it was imported
// and appends them to the existing pack (inheriting that pack's published state).
//
// Unlike the rest of /api this has NO admin session — it's exempted from the admin
// gate in hooks.server.ts and instead authenticates with a shared secret:
//   Authorization: Bearer <CRON_SECRET>
// where CRON_SECRET is a Cloudflare Pages secret (see wrangler.toml). Set the
// header on the external scheduler that hits this on a cron.
//
// New downloads per invocation are capped (CRON_MAX_NEW) so the run stays under
// Cloudflare's ~100s request limit; when capReached=true a backlog remains and the
// next scheduled run continues from where this one stopped. The run is idempotent:
// nothing new means no writes and a zero summary, and dedupe by
// telegram_file_unique_id means it never creates duplicates.
export const POST: RequestHandler = async ({ request, platform, url }) => {
	const env = platform?.env;

	// Auth: constant secret in an Authorization: Bearer header. If CRON_SECRET isn't
	// configured the endpoint can't be authenticated at all, so refuse rather than
	// run open.
	requireCronSecret(request, env);

	// Honor the same feature gate as the admin importer — no token, no Telegram.
	if (!isTelegramEnabled(env)) {
		error(503, 'Telegram is not configured (no bot token).');
	}

	const db = getDb(env!.DB);
	const settings = await getSettings(db);

	// Admin opt-in gate: the cron is wired up unconditionally, but does nothing
	// until an admin turns on auto re-sync in Settings. Return early (200) so the
	// scheduler sees success rather than retrying.
	if (!settings.autoResyncEnabled) {
		// Still a live heartbeat (proves the scheduler reached us), just a no-op run.
		schedule(platform, recordJobRun(db, 'resync-telegram', 'ok', 'skipped (disabled)'));
		return json({ skipped: true, reason: 'auto re-sync disabled' });
	}

	// Make a provider's relative URL (R2 dev '/img/...') absolute for storage, same
	// as the admin import actions.
	const absolutize = (u: string) => (u.startsWith('/') ? new URL(u, url.origin).href : u);

	// Observability (issue #6): heartbeat for the background-jobs panel. A thrown
	// error records a failed run before propagating, so the dashboard reflects it.
	let result;
	try {
		result = await resyncTelegramPacks({ env, settings, db, absolutize });
	} catch (e) {
		schedule(platform, recordJobRun(db, 'resync-telegram', 'failed',
			e instanceof Error ? e.message : 'resync failed'));
		throw e;
	}
	schedule(platform, recordJobRun(db, 'resync-telegram', 'ok', `imported ${result.imported}`));
	return json(result);
};
