import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Serves objects from the R2 bucket binding. Primary use is local dev (the
// the R2 custom domain fronts the real bucket, not miniflare's local one).
// In production, R2 images are served directly by the R2 custom domain, so this route
// is a fallback. Resized variants still go through cdnImage() / Image Transformations.
export const GET: RequestHandler = async ({ params, platform }) => {
	const key = params.key;
	if (!key) error(404, 'Not found');

	const object = await platform?.env.IMAGES?.get(key);
	if (!object) error(404, 'Not found');

	// Set headers from the object's metadata directly. (Avoid writeHttpMetadata():
	// it can't serialize a Headers across the dev getPlatformProxy boundary.)
	const headers = new Headers();
	if (object.httpMetadata?.contentType) headers.set('content-type', object.httpMetadata.contentType);
	headers.set('etag', object.httpEtag);
	headers.set('cache-control', 'public, max-age=31536000, immutable');
	return new Response(object.body, { headers });
};
