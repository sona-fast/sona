import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { isRegistryEnabled, registrySearch, resolveRegistryEnv } from '$lib/server/registry';
import type { RequestHandler } from './$types';

// GET /api/registry/search?q=<name>   (admin-only via hooks)
//
// Thin proxy so the admin UI (NewArtistDialog) can search the shared registry to
// pull an existing artist instead of re-entering them. Returns [] when the
// registry is disabled or unreachable — the dialog just falls back to manual entry.
export const GET: RequestHandler = async ({ url, platform }) => {
	const env = platform?.env;
	const renv = await resolveRegistryEnv(getDb(env!.DB), env);
	if (!isRegistryEnabled(renv)) return json({ enabled: false, artists: [] });

	const q = (url.searchParams.get('q') ?? '').trim();
	if (q.length < 2) return json({ enabled: true, artists: [] });

	const results = await registrySearch(renv, { q });
	// Only surface active records, and shape them for the dialog.
	const artists = results
		.filter((a) => a.status === 'active')
		.slice(0, 10)
		.map((a) => ({
			globalId: a.globalId,
			name: a.displayName,
			avatarUrl: a.avatarUrl,
			version: a.version,
			socials: a.socials
		}));
	return json({ enabled: true, artists });
};
