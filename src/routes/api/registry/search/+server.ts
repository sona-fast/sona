import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { isRegistryEnabled, registrySearch, resolveRegistryEnv } from '$lib/server/registry';
import type { RequestHandler } from './$types';

// GET /api/registry/search?q=<name>   (admin-only via hooks)
// GET /api/registry/search?handle=<url-or-handle>
//
// Thin proxy so the admin UI (NewArtistDialog) can search the shared registry to
// pull an existing artist instead of re-entering them — by name (`q`) or by a
// pasted social URL / @handle (`handle`, the registry normalizes it, same param
// artist-sync's backfill uses). Returns [] when the registry is disabled or
// unreachable — the dialog just falls back to manual entry.
export const GET: RequestHandler = async ({ url, platform }) => {
	const env = platform?.env;
	const renv = await resolveRegistryEnv(getDb(env!.DB), env);
	if (!isRegistryEnabled(renv)) return json({ enabled: false, artists: [] });

	const handle = (url.searchParams.get('handle') ?? '').trim();
	const q = (url.searchParams.get('q') ?? '').trim();
	// Handle search takes precedence when supplied; both gate on min length 2.
	if (handle.length >= 2) {
		const results = await registrySearch(renv, { handle });
		return json({ enabled: true, artists: shapeResults(results) });
	}
	if (q.length < 2) return json({ enabled: true, artists: [] });

	const results = await registrySearch(renv, { q });
	return json({ enabled: true, artists: shapeResults(results) });
};

// Only surface active records, and shape them for the dialog.
function shapeResults(results: Awaited<ReturnType<typeof registrySearch>>) {
	return results
		.filter((a) => a.status === 'active')
		.slice(0, 10)
		.map((a) => ({
			globalId: a.globalId,
			name: a.displayName,
			avatarUrl: a.avatarUrl,
			version: a.version,
			socials: a.socials
		}));
}
