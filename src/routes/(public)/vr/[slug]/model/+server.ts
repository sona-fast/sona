import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { vrAvatars } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getSettings } from '$lib/server/settings';
import { RateLimiter } from '$lib/server/rate-limit';
import { resolveModelBytes } from '$lib/server/vr-model-bytes';
import { viewerSupports } from '$lib/vr';
import type { RequestHandler } from './$types';

// Same throttle rationale as the download route (M10): each GET streams a
// whole model file, so an unthrottled loop amplifies bandwidth/cost.
const viewerLimiter = new RateLimiter(20, 60_000); // 20 fetches / min / IP

// GET /vr/[slug]/model
// The SAME-ORIGIN bytes the in-page 3D viewer fetches (CSP connect-src 'self':
// the raw, possibly cross-origin model_url never reaches the client). Bytes are
// resolved server-side and provider-aware — see resolveModelBytes.
//
// Deliberately NO license/downloadable check here: per the design doc, viewing
// is not gated by license — a viewable model is a fetchable model, and the
// download route's 403 enforces the OFFER (no forced-download affordance), not
// byte secrecy. What IS checked: published, a model present, and a format the
// viewer consumes (nothing else has a reason to fetch this route).
//   404 — unknown slug, unpublished, no self-hosted model, non-viewer format,
//         or nothing resolves the stored URL (all indistinguishable on purpose)
export const GET: RequestHandler = async ({ params, url, platform, getClientAddress }) => {
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
		'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600'
	});
	// Declared when known so the viewer can report byte progress.
	if (resolved.size !== null) headers.set('content-length', String(resolved.size));
	if (resolved.etag) headers.set('etag', resolved.etag);
	return new Response(resolved.body, { headers });
};
