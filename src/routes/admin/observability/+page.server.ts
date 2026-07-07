import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { getObservability, getCloudflareEdge } from '$lib/server/observability';
import type { PageServerLoad } from './$types';

// Admin-guarded by hooks.server.ts (every /admin/* path except login/setup/forgot/
// reset redirects to /admin/login without a session). Reads only THIS fork's own
// DB, so the Tier-B metrics are tenant-isolated by construction — see the note at
// the top of $lib/server/observability.ts.
export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db);
	const observability = await getObservability(db, settings, platform?.env);
	// Stream the OPTIONAL Cloudflare edge query: return the promise UNRESOLVED so the
	// shell and every in-app metric paint immediately (SvelteKit serialises the
	// pending promise). The CF panel fills in via {#await} when it resolves.
	// getCloudflareEdge never throws — it degrades to a not-configured/error state.
	return { observability, cfEdge: getCloudflareEdge(platform?.env) };
};
