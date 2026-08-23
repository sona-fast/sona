import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { proxyStoredImage } from '$lib/server/image-proxy';
import type { RequestHandler } from './$types';

// GET /api/admin/avatar  (admin-only via hooks — everything under /api except
// /api/cron/ requires the admin session).
//
// Streams the persona avatar same-origin so the con card can embed it as a
// data URI. The card draws the operator's face, and a badge whose job is
// letting someone confirm they met the right person is not doing that job with
// an initial on it. The avatar is frequently a hotlink (Bluesky's CDN, say)
// that `connect-src 'self'` blocks the page from fetching, and re-hosting can
// fail, so the card cannot rely on the stored URL being readable.
//
// The URL comes from settings, never from the caller, which is what keeps this
// from being an SSRF hole. See $lib/server/image-proxy.ts for the rest.
export const GET: RequestHandler = async ({ platform, fetch }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db);
	const avatarUrl = settings.adminAvatarUrl?.trim();
	if (!avatarUrl) error(404, 'No avatar is set');

	const response = await proxyStoredImage(avatarUrl, fetch);
	if (!response) error(502, 'Could not fetch the stored avatar');
	return response;
};
