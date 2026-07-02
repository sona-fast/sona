import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { artists } from '$lib/server/db/schema';
import { isRegistryEnabled } from '$lib/server/registry';
import {
	fetchRegistryCatalog,
	planImport,
	importRegistryCatalog
} from '$lib/server/registry-import';
import { getSettings, saveSettings } from '$lib/server/settings';
import type { RequestHandler } from './$types';

// GET  /api/registry/import  (admin-only via hooks)
//   Import plan for the New Artist dialog: how many artists the shared registry
//   holds, how many an "Import all" would create, and how many it would skip
//   (already linked, or handle-matched to an existing local artist). The count
//   comes from the registry's public delta endpoint, proxied server-side — the
//   registry worker itself is untouched.
//
// POST /api/registry/import  { keepUpdated?: boolean }
//   Runs the catalog import (see registry-import.ts for the skip/no-overwrite
//   invariants). `keepUpdated` wires the dialog's "keep imported artists
//   updated" checkbox to the EXISTING sync mechanism: it sets the site-wide
//   `registryOverridesLocal` setting that governs whether sync may refresh
//   linked artists' name/avatar/socials (there is no per-artist flag).
export const GET: RequestHandler = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const env = platform?.env;
	if (!isRegistryEnabled(env)) return json({ enabled: false });

	const [catalog, locals, settings] = await Promise.all([
		fetchRegistryCatalog(env),
		db.select().from(artists),
		getSettings(db)
	]);
	const plan = planImport(catalog, locals);
	return json({
		enabled: true,
		total: plan.total,
		toCreate: plan.toCreate.length,
		skipped: plan.skippedLinked + plan.skippedHandleMatched,
		keepUpdated: settings.registryOverridesLocal
	});
};

export const POST: RequestHandler = async ({ request, platform }) => {
	const db = getDb(platform!.env.DB);
	const env = platform?.env;
	if (!isRegistryEnabled(env)) return json({ enabled: false }, { status: 400 });

	const body = (await request.json().catch(() => null)) as { keepUpdated?: unknown } | null;
	if (typeof body?.keepUpdated === 'boolean') {
		await saveSettings(db, { registryOverridesLocal: body.keepUpdated });
	}

	const result = await importRegistryCatalog(db, env);
	if (!result) return json({ enabled: false }, { status: 400 });
	return json({ enabled: true, ...result });
};
