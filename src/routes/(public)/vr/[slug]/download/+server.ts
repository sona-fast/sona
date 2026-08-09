import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { vrAvatars } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getSettings } from '$lib/server/settings';
import { RateLimiter } from '$lib/server/rate-limit';
import { etagMatches, resolveModelBytes } from '$lib/server/vr-model-bytes';
import { isPermissiveVrLicense, modelExt } from '$lib/vr';
import type { RequestHandler } from './$types';

// Throttle like the sticker download proxy (M10): each GET streams a whole
// model file (tens of MB), so an unthrottled loop amplifies bandwidth/cost.
// Sized for humans saving a handful of avatars, not a pack of 120 stickers.
const downloadLimiter = new RateLimiter(20, 60_000); // 20 downloads / min / IP

// GET /vr/[slug]/download
// Streams a self-hosted avatar model as a forced download (Content-Disposition).
// Server-side enforcement is the point: the page hides the button for
// non-downloadable avatars, but a hand-crafted URL must be refused here too.
//   404 — unknown slug, unpublished, or no self-hosted model to serve
//   403 — model exists but isn't offered (downloadable off, restrictive
//         license, or no recorded permission to redistribute)
//
// What the 403 enforces is the OFFER — the owner's decision not to hand out
// the file with a download affordance — NOT byte secrecy: a viewable model is
// a fetchable model by design (the viewer endpoint /vr/[slug]/model serves the
// same bytes for any published VRM regardless of license; see the design doc).
//
// Byte resolution is shared with that endpoint (resolveModelBytes): R2 by the
// base-agnostic key rule, else the active non-R2 provider's own URL streamed
// through. Never buffered: models are far beyond what a worker should hold in
// memory.
export const GET: RequestHandler = async ({ params, request, url, platform, getClientAddress }) => {
	if (!downloadLimiter.check(getClientAddress(), Date.now())) {
		error(429, 'Too many downloads, please slow down.');
	}

	const db = getReadDb(platform!.env.DB);
	const row = await db
		.select({
			modelUrl: vrAvatars.modelUrl,
			modelFormat: vrAvatars.modelFormat,
			license: vrAvatars.license,
			permissionSource: vrAvatars.permissionSource,
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
	// can't override the license — and redistribution additionally requires a
	// RECORDED permission source (the fursuit rule: no permission record, no
	// redistribution; the form enforces the same pairing at save time).
	if (!row.downloadable || !isPermissiveVrLicense(row.license) || !row.permissionSource) {
		error(403, 'This model is not available for download.');
	}

	const settings = await getSettings(db);
	const resolved = await resolveModelBytes({
		modelUrl: row.modelUrl,
		origin: url.origin,
		env: platform?.env,
		settings
	});
	// Nothing we host or can proxy serves this URL — nothing to download.
	if (!resolved) error(404, 'Avatar not found');

	const ext = modelExt(row.modelFormat);
	const headers = new Headers({
		// VRM is a glTF-binary container, but no registered type exists for it;
		// octet-stream keeps browsers saving rather than trying to render.
		'Content-Type': 'application/octet-stream',
		'Content-Disposition': `attachment; filename="${params.slug}.${ext}"`,
		// Stored models are immutable objects, but the download URL's offer can be
		// revoked (unpublish, license change, downloadable off) — match the sticker
		// download's short shared-cache TTL so a takedown propagates promptly.
		// A short browser max-age spares an immediate re-download the transfer.
		'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'
	});
	if (resolved.etag) headers.set('etag', resolved.etag);
	// Conditional revalidation: a matching If-None-Match answers 304 instead of
	// re-streaming the whole file (shared etagMatches with the model route).
	if (resolved.etag && etagMatches(request.headers.get('if-none-match'), resolved.etag)) {
		void resolved.body.cancel();
		return new Response(null, { status: 304, headers });
	}
	// Declared when the source knows it (R2 always does; a proxied provider
	// should) so the browser can show download progress.
	if (resolved.size !== null) headers.set('content-length', String(resolved.size));
	return new Response(resolved.body, { headers });
};
