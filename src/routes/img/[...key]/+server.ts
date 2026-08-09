import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Serves objects from the R2 bucket binding. Primary use is local dev (the
// the R2 custom domain fronts the real bucket, not miniflare's local one).
// In production, R2 images are served directly by the R2 custom domain, so this route
// is a fallback. Resized variants still go through cdnImage() / Image Transformations.

/** A single-range Range header mapped to R2's get() range options, or null
 * for absent/malformed/multi-range headers (which fall back to the full body —
 * per RFC 9110 a server MAY ignore Range). Needed because no-CDN forks serve
 * VR showcase .webm clips through this route, and Safari refuses media whose
 * origin ignores its bytes=0-1 probe. */
function parseRange(header: string | null): { offset: number; length?: number } | { suffix: number } | null {
	const m = header?.match(/^bytes=(\d*)-(\d*)$/);
	if (!m || (m[1] === '' && m[2] === '')) return null;
	if (m[1] === '') return { suffix: Number(m[2]) };
	const offset = Number(m[1]);
	if (m[2] === '') return { offset };
	const end = Number(m[2]);
	if (end < offset) return null;
	return { offset, length: end - offset + 1 };
}

export const GET: RequestHandler = async ({ params, request, platform }) => {
	const key = params.key;
	if (!key) error(404, 'Not found');

	// VR model files are NOT images and must not be servable through this
	// route's immutable 1-year cache: their availability is revocable
	// (unpublish/removal must propagate). They are served exclusively by
	// /vr/[slug]/model, which carries a short shared-cache TTL.
	// ACCEPTED RESIDUAL (R2-S4): on forks with an R2 custom domain, a
	// vr-models/* object remains directly fetchable at that domain — this
	// refusal only closes the worker path. The keys are unguessable UUIDs the
	// client is never given (pages only ever emit /vr/[slug]/model), and the
	// design's posture is "viewable = fetchable", so we document rather than
	// re-architect (e.g. a separate private bucket).
	if (key.startsWith('vr-models/')) error(404, 'Not found');

	const range = parseRange(request.headers.get('range'));
	const object = range
		? await platform?.env.IMAGES?.get(key, { range })
		: await platform?.env.IMAGES?.get(key);
	if (!object) error(404, 'Not found');

	// Set headers from the object's metadata directly. (Avoid writeHttpMetadata():
	// it can't serialize a Headers across the dev getPlatformProxy boundary.)
	const headers = new Headers();
	if (object.httpMetadata?.contentType) headers.set('content-type', object.httpMetadata.contentType);
	headers.set('etag', object.httpEtag);
	headers.set('cache-control', 'public, max-age=31536000, immutable');
	headers.set('accept-ranges', 'bytes');
	// Ranged read (object.range is only set when the get above was ranged): a
	// 206 with Content-Range, sized to the returned slice — Safari probes media
	// with bytes=0-1 and refuses the clip if the origin ignores it.
	if (range && object.range) {
		const offset = 'offset' in object.range ? (object.range.offset ?? 0) : object.size - object.range.suffix;
		const length = ('length' in object.range ? object.range.length : undefined) ?? object.size - offset;
		headers.set('content-length', String(length));
		headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
		return new Response(object.body, { status: 206, headers });
	}
	// R2 knows the size, so declare it. A fork with no public CDN URL stores
	// /img/<key> URLs, and the sticker download's convert path only buffers a
	// body whose length the origin declares — without this it silently stops
	// offering PNG conversion on exactly those forks. Honest because this branch
	// is unranged: the body is always the whole object.
	headers.set('content-length', String(object.size));
	return new Response(object.body, { headers });
};
