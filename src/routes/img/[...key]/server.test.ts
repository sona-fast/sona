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

function event(key: string, images: ReturnType<typeof bucket> | undefined) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return { params: { key }, platform: { env: { IMAGES: images } } } as any;
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
