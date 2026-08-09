import { describe, it, expect } from 'vitest';
import { GET } from './+server';

// A stored object as R2 hands it back: body, httpEtag, size, and the metadata
// the route copies onto the response.
function bucket(objects: Record<string, { body: string; contentType?: string }>) {
	return {
		get: async (key: string) => {
			const o = objects[key];
			if (!o) return null;
			const bytes = new TextEncoder().encode(o.body);
			return {
				body: new Blob([bytes]).stream(),
				size: bytes.byteLength,
				httpEtag: `"etag-${key}"`,
				httpMetadata: o.contentType ? { contentType: o.contentType } : undefined
			};
		}
	};
}

function event(
	key: string,
	images: ReturnType<typeof bucket> | ReturnType<typeof rangedBucket> | undefined,
	headers: Record<string, string> = {}
) {
	const request = new Request(`http://localhost/img/${key}`, { headers });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { params: { key }, request, platform: { env: { IMAGES: images } } } as any;
}

// A range-aware bucket: honours R2's { range } get option and reports the
// served slice back via object.range, like the real binding.
function rangedBucket(objects: Record<string, { body: string; contentType?: string }>) {
	return {
		get: async (key: string, opts?: { range?: { offset?: number; length?: number; suffix?: number } }) => {
			const o = objects[key];
			if (!o) return null;
			const bytes = new TextEncoder().encode(o.body);
			let slice = bytes;
			let range: { offset: number; length: number } | undefined;
			if (opts?.range) {
				const offset =
					opts.range.suffix !== undefined ? bytes.byteLength - opts.range.suffix : (opts.range.offset ?? 0);
				const length = opts.range.length ?? bytes.byteLength - offset;
				slice = bytes.slice(offset, offset + length);
				range = { offset, length };
			}
			return {
				body: new Blob([slice]).stream(),
				size: bytes.byteLength,
				range,
				httpEtag: `"etag-${key}"`,
				httpMetadata: o.contentType ? { contentType: o.contentType } : undefined
			};
		}
	};
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
		const res = await GET(event('vr-media/clip.webm', rangedBucket(objects), { range: 'bytes=0-1' }));
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('WE');
		expect(res.headers.get('content-length')).toBe('2');
		expect(res.headers.get('content-range')).toBe('bytes 0-1/15');
		expect(res.headers.get('accept-ranges')).toBe('bytes');
	});

	it('answers an open-ended range (bytes=5-) from the offset to the end', async () => {
		const res = await GET(event('vr-media/clip.webm', rangedBucket(objects), { range: 'bytes=5-' }));
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('CLIP-BYTES');
		expect(res.headers.get('content-range')).toBe('bytes 5-14/15');
	});

	it('serves the full 200 body for a malformed or absent Range header', async () => {
		const malformed = await GET(
			event('vr-media/clip.webm', rangedBucket(objects), { range: 'bytes=weird' })
		);
		expect(malformed.status).toBe(200);
		expect(await malformed.text()).toBe('WEBM-CLIP-BYTES');
		const absent = await GET(event('vr-media/clip.webm', rangedBucket(objects)));
		expect(absent.status).toBe(200);
		expect(absent.headers.get('content-length')).toBe('15');
	});
});
