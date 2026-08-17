import { describe, it, expect } from 'vitest';
import { GET } from './+server';

/**
 * The R2 binding as the route actually meets it, on the behaviors this route
 * depends on — each of which has bitten it:
 *  - a ranged get THROWS on an unsatisfiable range rather than returning null
 *    (R3-D1), and object.range echoes the REQUESTED numbers unclamped, so the
 *    route must size its headers from object.size;
 *  - a get whose onlyIf precondition holds returns the object with NO body —
 *    metadata only, never null — and the precondition is evaluated BEFORE the
 *    range, so a matching validator short-circuits ahead of that throw (probed
 *    against a real binding, not assumed);
 *  - workerd rejects a quoted tag by throwing, which is why the route unquotes.
 *
 * Two known departures from the real binding, neither load-bearing here:
 * it throws for a shortlist of bad tags where workerd's parser is stricter (the
 * grammar itself is pinned in src/lib/server/etag.test.ts), and it reports
 * `range` only when one was asked for, where the real binding always populates
 * it. That second one masks a PRE-EXISTING defect in the unsatisfiable-range
 * fallback — against real R2 it answers 206 with a Content-Range covering the
 * whole object rather than the 200 the tests below expect. That is unchanged by
 * the conditional work and left alone deliberately; fixing it is its own change.
 */
function bucket(
	objects: Record<string, { body: string; contentType?: string }>,
	opts: { withheldBodyShape?: 'absent' | 'undefined' } = {}
) {
	const calls: { key: string; onlyIf?: { etagDoesNotMatch?: string }; range?: unknown }[] = [];
	return {
		calls,
		get: async (
			key: string,
			getOpts?: {
				range?: { offset?: number; length?: number; suffix?: number };
				onlyIf?: { etagDoesNotMatch?: string };
			}
		) => {
			const o = objects[key];
			if (!o) return null;
			calls.push({ key, onlyIf: getOpts?.onlyIf, range: getOpts?.range });
			const bytes = new TextEncoder().encode(o.body);
			const etag = `"etag-${key}"`;
			const tag = getOpts?.onlyIf?.etagDoesNotMatch;
			if (tag !== undefined && (tag.startsWith('"') || tag.startsWith('W/') || tag === 'garbage')) {
				throw new Error('get: Invalid ETag in if-none-match header (10040)');
			}
			const meta = {
				size: bytes.byteLength,
				range: getOpts?.range,
				httpEtag: etag,
				httpMetadata: o.contentType ? { contentType: o.contentType } : undefined
			};
			// Precondition holds (the client's tag matches): no body comes back.
			// Which of the two shapes R2 uses is what withheldBodyShape pins.
			if (tag !== undefined && `"${tag}"` === etag) {
				return opts.withheldBodyShape === 'undefined' ? { ...meta, body: undefined } : meta;
			}
			let slice = bytes;
			if (getOpts?.range) {
				let offset: number;
				if (getOpts.range.suffix !== undefined) {
					if (getOpts.range.suffix === 0) throw new Error('get: The requested range is not satisfiable (10039)');
					offset = Math.max(0, bytes.byteLength - getOpts.range.suffix);
				} else {
					offset = getOpts.range.offset ?? 0;
					if (offset >= bytes.byteLength) throw new Error('get: The requested range is not satisfiable (10039)');
				}
				const length = getOpts.range.length ?? bytes.byteLength - offset;
				slice = bytes.slice(offset, offset + length);
			}
			return { ...meta, body: new Blob([slice]).stream() };
		}
	};
}

function event(
	key: string,
	images: ReturnType<typeof bucket> | undefined,
	headers: Record<string, string> = {}
) {
	const request = new Request(`http://localhost/img/${key}`, { headers });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { params: { key }, request, platform: { env: { IMAGES: images } } } as any;
}

async function status(promise: Response | Promise<Response>): Promise<number> {
	try {
		return (await promise).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

describe('GET /img/[...key]', () => {
	it('declares the object size as content-length', async () => {
		// Not cosmetic: the sticker download's ?format=png path only buffers a body
		// whose length the origin declares (MAX_CONVERT_BYTES), and a fork with no
		// public CDN URL stores /img/<key> URLs — so an undeclared length here
		// silently turns PNG conversion off on exactly those forks.
		const res = await GET(event('stickers/pack/a.webp', bucket({
			'stickers/pack/a.webp': { body: 'twelve-bytes', contentType: 'image/webp' }
		})));
		expect(res.headers.get('content-length')).toBe('12');
		expect(res.headers.get('content-type')).toBe('image/webp');
		expect(res.headers.get('etag')).toBe('"etag-stickers/pack/a.webp"');
	});

	it('404s a missing key', async () => {
		await expect(status(GET(event('nope.webp', bucket({}))))).resolves.toBe(404);
	});

	it('404s when no bucket is bound', async () => {
		await expect(status(GET(event('a.webp', undefined)))).resolves.toBe(404);
	});

	it('refuses vr-models/* keys even when the object exists (SONA-124)', async () => {
		// Model bytes are served only by /vr/[slug]/model with a short TTL — this
		// route's immutable 1y cache would immortalize a revoked model.
		const images = bucket({ 'vr-models/abc.vrm': { body: 'MODEL' } });
		await expect(status(GET(event('vr-models/abc.vrm', images)))).resolves.toBe(404);
	});
});

describe('GET /img/[...key] — Range requests (R2-D7)', () => {
	// Safari probes media with `Range: bytes=0-1` and refuses to play a clip
	// whose origin answers 200-with-everything — and no-CDN forks serve VR
	// showcase .webm clips through exactly this route.
	const objects = { 'vr-media/clip.webm': { body: 'WEBM-CLIP-BYTES', contentType: 'video/webm' } };

	it('answers a bounded range with 206 + Content-Range and the sliced body', async () => {
		const res = await GET(event('vr-media/clip.webm', bucket(objects), { range: 'bytes=0-1' }));
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('WE');
		expect(res.headers.get('content-length')).toBe('2');
		expect(res.headers.get('content-range')).toBe('bytes 0-1/15');
		expect(res.headers.get('accept-ranges')).toBe('bytes');
	});

	it('answers an open-ended range (bytes=5-) from the offset to the end', async () => {
		const res = await GET(event('vr-media/clip.webm', bucket(objects), { range: 'bytes=5-' }));
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('CLIP-BYTES');
		expect(res.headers.get('content-range')).toBe('bytes 5-14/15');
	});

	it('serves the full 200 body for a malformed or absent Range header', async () => {
		const malformed = await GET(
			event('vr-media/clip.webm', bucket(objects), { range: 'bytes=weird' })
		);
		expect(malformed.status).toBe(200);
		expect(await malformed.text()).toBe('WEBM-CLIP-BYTES');
		const absent = await GET(event('vr-media/clip.webm', bucket(objects)));
		expect(absent.status).toBe(200);
		expect(absent.headers.get('content-length')).toBe('15');
	});

	// R2 THROWS on unsatisfiable ranges instead of returning null; unguarded,
	// each of these was an anonymous 500 — a regression against the pre-range
	// route, which answered 200 (R3-D1). RFC 9110 lets a server ignore Range.
	for (const header of ['bytes=99-', 'bytes=15-', 'bytes=-0']) {
		it(`falls back to the full 200 body when R2 rejects the range (${header})`, async () => {
			const res = await GET(event('vr-media/clip.webm', bucket(objects), { range: header }));
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('WEBM-CLIP-BYTES');
			expect(res.headers.get('content-length')).toBe('15');
			expect(res.headers.get('content-range')).toBeNull();
		});
	}

	it('clamps Content-Range/Content-Length from object.size, not the client numbers', async () => {
		// object.range echoes the request unclamped (see bucket): a length
		// running past the end must not produce a Content-Range that lies.
		const overlong = await GET(
			event('vr-media/clip.webm', bucket(objects), { range: 'bytes=5-9999' })
		);
		expect(overlong.status).toBe(206);
		expect(overlong.headers.get('content-range')).toBe('bytes 5-14/15');
		expect(overlong.headers.get('content-length')).toBe('10');
		// A suffix longer than the object serves the whole body from offset 0.
		const suffix = await GET(
			event('vr-media/clip.webm', bucket(objects), { range: 'bytes=-9999' })
		);
		expect(suffix.status).toBe(206);
		expect(suffix.headers.get('content-range')).toBe('bytes 0-14/15');
		expect(suffix.headers.get('content-length')).toBe('15');
	});
});

describe('GET /img/[...key] — conditional requests', () => {
	const KEY = 'stickers/pack/a.webp';
	const ETAG = `"etag-${KEY}"`;
	const objects = { [KEY]: { body: 'twelve-bytes', contentType: 'image/webp' } };

	it('answers a matching If-None-Match with a bodyless 304', async () => {
		const images = bucket(objects);
		const res = await GET(event(KEY, images, { 'if-none-match': ETAG }));

		// The validator has to reach R2 unquoted — workerd rejects the quoted form
		// outright — and reaching it is the whole saving: R2 withholds the body, so
		// a revalidation costs metadata rather than a full object read.
		expect(images.calls).toHaveLength(1);
		expect(images.calls[0].onlyIf?.etagDoesNotMatch).toBe(`etag-${KEY}`);
		expect(res.status).toBe(304);
		expect(res.body).toBeNull();
		// Same validator and freshness the 200 carries, or the next revalidation
		// runs against a weaker copy.
		expect(res.headers.get('etag')).toBe(ETAG);
		expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		// Representation headers describe bytes we are not sending.
		expect(res.headers.get('content-type')).toBeNull();
		expect(res.headers.get('content-length')).toBeNull();
	});

	it('answers a 304 when R2 reports the withheld body as undefined', async () => {
		// The docs describe the precondition-held object as one whose body is
		// undefined; workerd returns a base R2Object with no body property at all.
		// The route must not depend on which, or the "saving" silently becomes a
		// 200 declaring a content-length over an empty body, cached for a year.
		const images = bucket(objects, { withheldBodyShape: 'undefined' });
		const res = await GET(event(KEY, images, { 'if-none-match': ETAG }));

		expect(res.status).toBe(304);
		expect(res.body).toBeNull();
		expect(res.headers.get('etag')).toBe(ETAG);
	});

	it('serves the full 200 when the validator does not match', async () => {
		const images = bucket(objects);
		const res = await GET(event(KEY, images, { 'if-none-match': '"stale"' }));

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('twelve-bytes');
		expect(res.headers.get('etag')).toBe(ETAG);
		expect(res.headers.get('content-length')).toBe('12');
	});

	it('sends no condition to R2 when the client sent none', async () => {
		const images = bucket(objects);
		const res = await GET(event(KEY, images));

		expect(images.calls[0].onlyIf).toBeUndefined();
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/webp');
	});

	describe('validators that are not forwarded', () => {
		// workerd compares strongly and throws on anything it cannot parse, so the
		// route screens the header first: these forms would either never match or
		// take the whole request down, and a plain 200 is the right answer to all
		// of them. `*` and comma-lists are refused for the same reason the sticker
		// route refuses them — see singleValidator.
		it.each([
			['a weak validator', `W/${ETAG}`],
			['a comma-separated list', `"other", ${ETAG}`],
			['a wildcard', '*'],
			// Quoted, this is a legal tag naming the opaque value `*` — but R2 reads
			// the unquoted form as the wildcard, so forwarding it would 304 a client
			// that holds nothing.
			['a quoted wildcard', '"*"'],
			['an unquoted etag', `etag-${KEY}`],
			['a malformed validator', 'garbage']
		])('serves a 200 for %s without asking R2 to compare it', async (_label, value) => {
			const images = bucket(objects);
			const res = await GET(event(KEY, images, { 'if-none-match': value }));

			expect(images.calls[0].onlyIf).toBeUndefined();
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('twelve-bytes');
		});
	});

	it('answers a conditional range request with 304, not 206', async () => {
		// RFC 9110 §13.2.2 evaluates If-None-Match before Range: a client that
		// already holds the bytes must not be handed a partial response. Safari's
		// bytes=0-1 media probe on a cached VR clip is exactly this shape.
		const key = 'vr-media/clip.webm';
		const images = bucket({ [key]: { body: 'WEBM-CLIP-BYTES', contentType: 'video/webm' } });
		const res = await GET(
			event(key, images, { 'if-none-match': `"etag-${key}"`, range: 'bytes=0-1' })
		);

		expect(res.status).toBe(304);
		expect(res.body).toBeNull();
		expect(res.headers.get('content-range')).toBeNull();
	});

	it('still 304s a matching validator carrying an unsatisfiable range', async () => {
		// R2 evaluates the conditional before the range, so a match is answered
		// bodyless and never reaches the throw — the client gets its 304 even
		// though the range it asked for could not have been served.
		const images = bucket(objects);
		const res = await GET(event(KEY, images, { 'if-none-match': ETAG, range: 'bytes=-0' }));

		expect(res.status).toBe(304);
		expect(res.body).toBeNull();
		expect(images.calls).toHaveLength(1);
	});

	it('serves a 200 rather than 500 when a non-matching conditional meets a bad range', async () => {
		// Here the range really does throw, and the fallback drops BOTH options:
		// whichever one R2 rejected, a bare get succeeds. Re-sending the option
		// that just threw would turn R3-D1's safety net into a repeat of the
		// failure, which is the anonymous 500 it exists to prevent.
		const images = bucket(objects);
		const res = await GET(event(KEY, images, { 'if-none-match': '"stale"', range: 'bytes=-0' }));

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('twelve-bytes');
		expect(images.calls).toHaveLength(2);
		expect(images.calls[1].onlyIf).toBeUndefined();
		expect(images.calls[1].range).toBeUndefined();
	});
});
