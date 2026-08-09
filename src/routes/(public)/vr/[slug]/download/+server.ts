import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { vrAvatars } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getSettings } from '$lib/server/settings';
import { RateLimiter } from '$lib/server/rate-limit';
import { deriveModelKey, isPermissiveVrLicense, modelExt } from '$lib/vr';
import type { RequestHandler } from './$types';

// Throttle like the sticker download proxy (M10): each GET streams a whole
// model file (tens of MB), so an unthrottled loop amplifies bandwidth/cost.
// Sized for humans saving a handful of avatars, not a pack of 120 stickers.
const downloadLimiter = new RateLimiter(20, 60_000); // 20 downloads / min / IP

const CONTENT_TYPES: Record<string, string> = {
	// VRM is a glTF-binary container, but no registered type exists for it;
	// octet-stream keeps browsers saving rather than trying to render.
	vrm: 'application/octet-stream',
	fbx: 'application/octet-stream'
};

// GET /vr/[slug]/download
// Streams a self-hosted avatar model as a forced download (Content-Disposition).
// Server-side enforcement is the point: the page hides the button for
// non-downloadable avatars, but a hand-crafted URL must be refused here too.
//   404 — unknown slug, unpublished, or no self-hosted model to serve
//   403 — model exists but isn't offered (downloadable off, restrictive license)
//
// The bytes are served from the R2 binding, exactly like /img/[...key] (the
// same-origin serving route the viewer uses): the stored model_url is mapped
// back to its object key (deriveModelKey — the deleteOrphans pathname rule) and
// object.body is STREAMED into the response. Never buffered: models are far
// beyond what a worker should hold in memory (no bufferStream here).
export const GET: RequestHandler = async ({ params, url, platform, getClientAddress }) => {
	if (!downloadLimiter.check(getClientAddress(), Date.now())) {
		error(429, 'Too many downloads, please slow down.');
	}

	const db = getReadDb(platform!.env.DB);
	const row = await db
		.select({
			modelUrl: vrAvatars.modelUrl,
			modelFormat: vrAvatars.modelFormat,
			license: vrAvatars.license,
			downloadable: vrAvatars.downloadable,
			published: vrAvatars.published
		})
		.from(vrAvatars)
		.where(eq(vrAvatars.slug, params.slug))
		.get();

	// Unpublished is indistinguishable from unknown on purpose — a draft's
	// existence is not public information. Same for "no model file".
	if (!row || !row.published || !row.modelUrl) error(404, 'Avatar not found');

	// The avatar exists publicly but its file isn't offered: 403, not 404.
	// Restrictive licenses are refused even with downloadable=true — the flag
	// can't override the license.
	if (!row.downloadable || !isPermissiveVrLicense(row.license)) {
		error(403, 'This model is not available for download.');
	}

	const settings = await getSettings(db);
	const key = deriveModelKey(row.modelUrl, {
		origin: url.origin,
		r2PublicUrl: settings.r2PublicUrl
	});
	// A foreign-host model_url maps to no key of ours — nothing we can serve.
	if (!key) error(404, 'Avatar not found');

	const object = await platform?.env.IMAGES?.get(key);
	if (!object) error(404, 'Avatar not found');

	const ext = modelExt(row.modelFormat);
	const headers = new Headers({
		'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
		'Content-Disposition': `attachment; filename="${params.slug}.${ext}"`,
		// Stored models are immutable objects, but the download URL's offer can be
		// revoked (unpublish, license change, downloadable off) — match the sticker
		// download's short shared-cache TTL so a takedown propagates promptly.
		'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600'
	});
	// R2 knows the size; declare it so the browser can show download progress.
	headers.set('content-length', String(object.size));
	headers.set('etag', object.httpEtag);
	return new Response(object.body, { headers });
};
