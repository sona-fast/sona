import { error } from '@sveltejs/kit';
import { r2ConditionalTag } from '$lib/server/etag';
import type { RequestHandler } from './$types';

// Serves objects from the R2 bucket binding. Primary use is local dev (the
// the R2 custom domain fronts the real bucket, not miniflare's local one).
// In production, R2 images are served directly by the R2 custom domain, so this route
// is a fallback. Resized variants still go through cdnImage() / Image Transformations.

// Immutable because the keys are content-addressed: a changed image is a new
// key, never new bytes under the old one. Both halves of a revalidation carry
// it, the 200 and the 304 alike.
const IMG_CACHE_CONTROL = 'public, max-age=31536000, immutable';

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
	// Ask R2 to skip reading the object when the client already has it. This has
	// to be an R2Conditional POJO, NOT the Headers form the binding also accepts:
	// in dev the binding is a miniflare stub behind getPlatformProxy, whose
	// serializer only recognizes its own bundled Headers class, so a global
	// Headers throws "Cannot stringify arbitrary non-POJOs" on every conditional
	// request — the same boundary that keeps writeHttpMetadata() out of this
	// route, below. r2ConditionalTag also screens the value: workerd throws on a
	// QUOTED tag, compares strongly, and reads a bare `*` as the wildcard, so the
	// quoted, weak and wildcard forms are all kept away from it — the first would
	// be a 500, the second could never match, the third would 304 a client that
	// holds nothing.
	const onlyIf = r2ConditionalTag(request.headers.get('if-none-match'));
	let object;
	try {
		object = await platform?.env.IMAGES?.get(key, {
			...(range ? { range } : {}),
			...(onlyIf ? { onlyIf: { etagDoesNotMatch: onlyIf } } : {})
		});
	} catch {
		// R2 THROWS on an unsatisfiable range (offset at/past the end, bytes=-0)
		// rather than returning null — unguarded, that surfaced as an anonymous
		// 500 (R3-D1). RFC 9110 lets a server ignore Range, so fall back to the
		// unranged full body; the object.range check below then serves a 200.
		// The fallback drops the conditional too, deliberately: whatever the
		// options made R2 reject, a bare get still succeeds, and re-sending the
		// option that just threw would turn this safety net into a repeat of the
		// failure. It costs only the 304 on a conditional-plus-bad-range request.
		object = await platform?.env.IMAGES?.get(key);
	}
	if (!object) error(404, 'Not found');

	// A satisfied If-None-Match makes R2 withhold the body, which is the whole
	// saving: the object is never read, only its metadata. Answer the
	// revalidation bodyless, carrying the same validator and freshness the 200
	// would have. This also fires ahead of any Range handling, as it must —
	// RFC 9110 §13.2.2 evaluates If-None-Match first, so a matching validator
	// means 304 and not 206. (`'body' in object` narrows the union; the second
	// test is what actually decides, since the docs describe the withheld case
	// as a body that is undefined rather than a property that is absent.)
	// Gated on the conditional having been SENT: a 304 is only ever an answer to
	// one, so a bodyless object on an unconditional request is not a revalidation
	// hit — the client holds nothing, and 304 would strand it with no bytes and a
	// year of freshness. R2 has no reason to withhold a body there, so that shape
	// is an anomaly rather than a saving, and it fails loudly instead.
	if (onlyIf && (!('body' in object) || !object.body)) {
		return new Response(null, {
			status: 304,
			headers: { etag: object.httpEtag, 'cache-control': IMG_CACHE_CONTROL }
		});
	}
	// The other half of that gate: an unconditional get with no body cannot be
	// served as a 200 either — that declares a content-length over an empty body
	// and caches it immutably for a year.
	if (!('body' in object) || !object.body) error(500, 'Image body unavailable');

	// Set headers from the object's metadata directly. (Avoid writeHttpMetadata():
	// it can't serialize a Headers across the dev getPlatformProxy boundary.)
	const headers = new Headers();
	if (object.httpMetadata?.contentType) headers.set('content-type', object.httpMetadata.contentType);
	headers.set('etag', object.httpEtag);
	headers.set('cache-control', IMG_CACHE_CONTROL);
	headers.set('accept-ranges', 'bytes');
	// Ranged read (object.range is only set when the get above was ranged): a
	// 206 with Content-Range, sized to the returned slice — Safari probes media
	// with bytes=0-1 and refuses the clip if the origin ignores it. Offset and
	// length are clamped from object.size/object.range (what R2 actually
	// served), never taken from the client's numbers: a suffix longer than the
	// object or a length running past the end must not produce a Content-Range
	// that lies about the body.
	if (range && object.range) {
		const rawOffset =
			'offset' in object.range ? (object.range.offset ?? 0) : object.size - object.range.suffix;
		const offset = Math.max(0, rawOffset);
		const rawLength = ('length' in object.range ? object.range.length : undefined) ?? object.size - offset;
		const length = Math.min(rawLength, object.size - offset);
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
