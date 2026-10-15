import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { artists } from '$lib/server/db/schema';
import { parseArtistLink } from '$lib/server/artist-from-link';
import { findLocalArtistsByHandle } from '$lib/server/handle-normalize';
import { findArtistsByName } from '$lib/server/fuzzysearch';
import type { RequestHandler } from './$types';

// POST /api/admin/artist-from-link (admin-only via hooks: everything under
// /api except /api/cron/ requires the admin session).
//
// Paste a link (SONA-236): body { url } → the artist the link names, and the
// local artists that already hold that handle. The link is parsed, never
// fetched, and never logged: it can be a private chat link. POST rather than
// GET keeps it out of query strings and access logs.

export const POST: RequestHandler = async ({ request, platform }) => {
	let url: unknown;
	try {
		({ url } = (await request.json()) as { url?: unknown });
	} catch {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}
	if (typeof url !== 'string') return json({ ok: false, reason: 'invalid' }, { status: 400 });

	const parsed = parseArtistLink(url);
	if (!parsed.ok) return json(parsed);

	const db = getDb(platform!.env.DB);
	const rows = await db
		.select({
			id: artists.id,
			name: artists.name,
			twitterUrl: artists.twitterUrl,
			blueskyUrl: artists.blueskyUrl,
			telegramUrl: artists.telegramUrl,
			furAffinityUrl: artists.furAffinityUrl,
			deviantArtUrl: artists.deviantArtUrl,
			patreonUrl: artists.patreonUrl,
			instagramUrl: artists.instagramUrl
		})
		.from(artists)
		.orderBy(artists.name);

	// Only ids and names leave: the page needs to pick an artist, not read
	// their socials.
	const pick = ({ id, name }: { id: number; name: string }) => ({ id, name });
	const matches = findLocalArtistsByHandle(rows, parsed.platform, [parsed.handle]).map(pick);
	// A name equal to the handle is weaker evidence than a stored handle, so it's
	// offered for the owner to choose, never picked for them.
	const matched = new Set(matches.map((a) => a.id));
	const nameMatches = findArtistsByName(rows, parsed.handle)
		.filter((a) => !matched.has(a.id))
		.map(pick);

	return json({ ...parsed, matches, nameMatches });
};

// Said outright rather than left to the router: the link must never ride in a
// query string, so a GET is refused even if someone adds one by mistake.
export const GET: RequestHandler = () =>
	new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
