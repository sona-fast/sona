import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { vrAvatars } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getSettings } from '$lib/server/settings';
import { RateLimiter } from '$lib/server/rate-limit';
import { etagMatches, resolveModelBytes } from '$lib/server/vr-model-bytes';
import { viewerSupports } from '$lib/vr';
import type { RequestHandler } from './$types';

// Same throttle rationale as the download route (M10): each GET streams a
// whole model file, so an unthrottled loop amplifies bandwidth/cost.
const viewerLimiter = new RateLimiter(20, 60_000); // 20 fetches / min / IP

// GET /vr/[slug]/model
// The SAME-ORIGIN bytes the in-page 3D viewer fetches (connect-src permits no
// network origin beyond 'self', so the raw, possibly cross-origin model_url
// never reaches the client). Bytes are resolved server-side and
// provider-aware — see resolveModelBytes.
//
// Deliberately NO license/downloadable check here: per the design doc, viewing
// is not gated by license — a viewable model is a fetchable model, and the
// download route's 403 enforces the OFFER (no forced-download affordance), not
// byte secrecy. What IS checked: published, a model present, and a format the
// viewer consumes (nothing else has a reason to fetch this route).
//   404 — unknown slug, unpublished, no self-hosted model, non-viewer format,
//         or nothing resolves the stored URL (all indistinguishable on purpose)
export const GET: RequestHandler = async ({ params, request, url, platform, getClientAddress }) => {
	if (!viewerLimiter.check(getClientAddress(), Date.now())) {
		error(429, 'Too many requests, please slow down.');
	}

	const db = getReadDb(platform!.env.DB);
	const row = await db
		.select({
			modelUrl: vrAvatars.modelUrl,
			modelFormat: vrAvatars.modelFormat,
			published: vrAvatars.published
		})
		.from(vrAvatars)
		.where(eq(vrAvatars.slug, params.slug))
		.get();

	if (!row || !row.published || !row.modelUrl || !viewerSupports(row.modelFormat)) {
		error(404, 'Avatar not found');
	}

	const settings = await getSettings(db);
	const resolved = await resolveModelBytes({
		modelUrl: row.modelUrl,
		origin: url.origin,
		env: platform?.env,
		settings
	});
	if (!resolved) error(404, 'Avatar not found');

	const headers = new Headers({
		'Content-Type': 'application/octet-stream',
		// Models are opaque bytes for the GLTF parser; never let a browser sniff
		// them into something renderable.
		'X-Content-Type-Options': 'nosniff',
		// NOT immutable, unlike /img: the model URL's availability can be revoked
		// (unpublish, model removed) and that must propagate instead of being
		// immortalized in shared caches — same short TTL as the download route.
		// A short browser max-age spares repeat views the multi-MB re-transfer.
		// No stale-while-revalidate: a revoked model must not be servable from a
		// shared cache's stale window — revocation propagates within s-maxage.
		'Cache-Control': 'public, max-age=60, s-maxage=300'
	});
	if (resolved.etag) headers.set('etag', resolved.etag);
	// Conditional revalidation: past max-age the browser revalidates with
	// If-None-Match; matching the R2 httpEtag turns a multi-MB re-stream into a
	// 304. Simple exact/list match — R2 etags are strong.
	if (resolved.etag && etagMatches(request.headers.get('if-none-match'), resolved.etag)) {
		void resolved.body.cancel().catch(() => {});
		return new Response(null, { status: 304, headers });
	}
	// Declared when known so the viewer can report byte progress.
	if (resolved.size !== null) headers.set('content-length', String(resolved.size));
	return new Response(resolved.body, { headers });
};
