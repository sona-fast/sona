import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { resolveOrCreateArtist } from '$lib/server/sticker-import';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import type { RequestHandler } from './$types';

// POST /api/artists  (admin-only via hooks)
// Creates an artist immediately and returns { id, name } so the sticker import
// review (and other admin UIs) can add a new artist on the fly and instantly use
// it in every dropdown — no pending/staging dance. Reuses resolveOrCreateArtist
// (which also resolves an avatar from the social links).
export const POST: RequestHandler = async ({ request, platform }) => {
	const db = getDb(platform!.env.DB);
	const body = (await request.json().catch(() => null)) as Record<string, string> | null;
	if (!body) error(400, 'Invalid request body');

	const name = sanitizeText(body.name ?? '', 200);
	if (!name) error(400, 'Artist name is required');

	const id = await resolveOrCreateArtist(db, {
		artistId: null,
		artistName: name,
		twitterUrl: sanitizeUrl(body.twitter ?? ''),
		blueskyUrl: sanitizeUrl(body.bluesky ?? ''),
		telegramUrl: sanitizeUrl(body.telegram ?? ''),
		furAffinityUrl: sanitizeUrl(body.furaffinity ?? ''),
		deviantArtUrl: sanitizeUrl(body.deviantart ?? ''),
		patreonUrl: sanitizeUrl(body.patreon ?? ''),
		instagramUrl: sanitizeUrl(body.instagram ?? '')
	});
	if (!id) error(400, 'Could not create artist');

	return json({ id, name });
};
