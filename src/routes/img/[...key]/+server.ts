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
	// R2 knows the size, so declare it. A fork with no public CDN URL stores
	// /img/<key> URLs, and the sticker download's convert path only buffers a
	// body whose length the origin declares — without this it silently stops
	// offering PNG conversion on exactly those forks. Honest because the get()
	// above is unconditional and unranged: the body is always the whole object.
	headers.set('content-length', String(object.size));
	headers.set('etag', object.httpEtag);
	headers.set('cache-control', 'public, max-age=31536000, immutable');
	return new Response(object.body, { headers });
};
