import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { artists } from '$lib/server/db/schema';
import { isRegistryEnabled, isRegistryRefusal, resolveRegistryEnv } from '$lib/server/registry';
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
//   comes from the registry's delta endpoint (authenticated with this fork's key),
//   proxied server-side — the registry worker itself is untouched.
//
// POST /api/registry/import  { keepUpdated?: boolean }
//   Runs the catalog import (see registry-import.ts for the skip/no-overwrite
//   invariants). `keepUpdated` wires the dialog's "keep imported artists
//   updated" checkbox to the EXISTING sync mechanism: it sets the site-wide
//   `registryOverridesLocal` setting that governs whether sync may refresh
//   linked artists' name/avatar/socials (there is no per-artist flag).
export const GET: RequestHandler = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const renv = await resolveRegistryEnv(db, platform?.env);
	if (!isRegistryEnabled(renv)) return json({ enabled: false });

	const [catalog, locals, settings] = await Promise.all([
		fetchRegistryCatalog(renv),
		db.select().from(artists),
		getSettings(db)
	]);
	// The registry refused us (e.g. 401 on a bad fork key): report the failure rather
	// than a plan of 0 artists, which would read as "the registry is empty".
	if (isRegistryRefusal(catalog))
		return json({ error: catalog.error.slice(0, 300) }, { status: 502 });
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
	const renv = await resolveRegistryEnv(db, platform?.env);
	if (!isRegistryEnabled(renv)) return json({ enabled: false }, { status: 400 });

	const body = (await request.json().catch(() => null)) as { keepUpdated?: unknown } | null;
	if (typeof body?.keepUpdated === 'boolean') {
		await saveSettings(db, { registryOverridesLocal: body.keepUpdated });
	}

	const result = await importRegistryCatalog(db, renv);
	if (!result) return json({ enabled: false }, { status: 400 });
	// A refusal imported nothing — fail the request so the dialog shows its import
	// error instead of an "imported 0 artists" success toast.
	if (isRegistryRefusal(result))
		return json({ error: result.error.slice(0, 300) }, { status: 502 });
	return json({ enabled: true, ...result });
};
