import { describe, it, expect, vi } from 'vitest';
import { getStorage } from './index';
import { scrubImageMetadata, UnscrubbableImageError } from './scrub-metadata';
import { jpegFixture } from './scrub-metadata.fixtures';
import type { SiteSettings } from '$lib/server/settings';

// The decorator is not exported through getStorage's signature on purpose:
// these tests go through getStorage, because "you cannot reach a provider that
// skips the scrub" is the property worth pinning.

type Env = Parameters<typeof getStorage>[0];

interface Stored {
	key: string;
	bytes: Uint8Array;
	contentType: string | undefined;
}

function bucketRecording(stored: Stored[]) {
	return {
		put: vi.fn(async (key: string, body: unknown, opts?: { httpMetadata?: { contentType?: string } }) => {
			let bytes: Uint8Array;
			if (body instanceof ReadableStream) bytes = new Uint8Array(await new Response(body).arrayBuffer());
			else if (body instanceof Uint8Array) bytes = body;
			else bytes = new Uint8Array(body as ArrayBuffer);
			stored.push({ key, bytes, contentType: opts?.httpMetadata?.contentType });
		}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({ objects: [], truncated: false }))
	};
}

function storageFor(stored: Stored[]) {
	const bucket = bucketRecording(stored);
	const settings = { storageProvider: 'r2', r2PublicUrl: 'https://cdn.test' } as unknown as SiteSettings;
	return { storage: getStorage({ IMAGES: bucket } as unknown as Env, settings), bucket };
}

function streamOf(bytes: Uint8Array, chunkSize = 7): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (let at = 0; at < bytes.length; at += chunkSize) {
				controller.enqueue(bytes.subarray(at, Math.min(at + chunkSize, bytes.length)));
			}
			controller.close();
		}
	});
}

describe('getStorage wraps the provider in metadata scrubbing', () => {
	it('scrubs a buffered raster body', async () => {
		const stored: Stored[] = [];
		const { storage } = storageFor(stored);
		const jpeg = jpegFixture();
		await storage.put({
			suggestedKey: 'artwork/a.jpg',
			body: jpeg,
			contentType: 'image/jpeg',
			filename: 'a.jpg'
		});
		expect(stored).toHaveLength(1);
		expect(stored[0].bytes).toEqual(scrubImageMetadata(jpeg));
		expect(stored[0].bytes.length).toBe(jpeg.length);
		// The GPS coordinates that were in the original are not in the object.
		expect(new TextDecoder('latin1').decode(stored[0].bytes)).not.toContain('GPSLatitude');
	});

	it('scrubs an ArrayBuffer body too', async () => {
		const stored: Stored[] = [];
		const { storage } = storageFor(stored);
		const jpeg = jpegFixture();
		const copy = jpeg.slice();
		await storage.put({
			suggestedKey: 'artwork/b.jpg',
			body: copy.buffer as ArrayBuffer,
			contentType: 'image/jpeg',
			filename: 'b.jpg'
		});
		expect(stored[0].bytes).toEqual(scrubImageMetadata(jpeg));
	});

	it('scrubs a streamed body and leaves the declared size unchanged', async () => {
		const stored: Stored[] = [];
		const { storage } = storageFor(stored);
		const jpeg = jpegFixture();
		await storage.put({
			suggestedKey: 'artwork/c.jpg',
			body: streamOf(jpeg),
			size: jpeg.length,
			contentType: 'image/jpeg',
			filename: 'c.jpg'
		});
		// A size mismatch would have made R2Storage's length check throw, so
		// arriving here at all proves the scrub preserved the declared length.
		expect(stored[0].bytes).toEqual(scrubImageMetadata(jpeg));
		expect(stored[0].bytes.length).toBe(jpeg.length);
	});

	it('passes non-raster content types through untouched', async () => {
		const stored: Stored[] = [];
		const { storage } = storageFor(stored);
		const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
		const lottie = new TextEncoder().encode('{"v":"5.7.4"}');
		await storage.put({
			suggestedKey: 'vr-media/clip.webm',
			body: webm,
			contentType: 'video/webm',
			filename: 'clip.webm'
		});
		await storage.put({
			suggestedKey: 'stickers/x.json',
			body: lottie,
			contentType: 'application/json',
			filename: 'x.json'
		});
		expect(stored[0].bytes).toEqual(webm);
		expect(stored[1].bytes).toEqual(lottie);
	});

	it('scrubs raster bytes stored under a non-image content type', async () => {
		// The sticker import takes its content type from a Telegram file path, so
		// a JPEG served under a .webm path arrives declared video/webm. Gating on
		// the declared type alone stored those bytes, GPS and all.
		const stored: Stored[] = [];
		const { storage } = storageFor(stored);
		const jpeg = jpegFixture();
		await storage.put({
			suggestedKey: 'stickers/mislabelled.webm',
			body: jpeg,
			contentType: 'video/webm',
			filename: 'mislabelled.webm'
		});
		expect(stored[0].bytes).toEqual(scrubImageMetadata(jpeg));
		expect(new TextDecoder('latin1').decode(stored[0].bytes)).not.toContain('GPSLatitude');
	});

	it('scrubs raster bytes STREAMED under a non-image content type', async () => {
		const stored: Stored[] = [];
		const { storage } = storageFor(stored);
		const jpeg = jpegFixture();
		await storage.put({
			suggestedKey: 'stickers/mislabelled-stream.webm',
			body: streamOf(jpeg),
			size: jpeg.length,
			contentType: 'video/webm',
			filename: 'mislabelled-stream.webm'
		});
		expect(stored[0].bytes).toEqual(scrubImageMetadata(jpeg));
		expect(stored[0].bytes.length).toBe(jpeg.length);
	});

	it('streams a non-raster body through the sniff byte-identical', async () => {
		// The VR model path: octet-stream bytes that sniff as no raster still reach
		// the provider whole, and in chunks — the peek replays the head rather than
		// buffering the file.
		const stored: Stored[] = [];
		const { storage } = storageFor(stored);
		const model = new Uint8Array([...new TextEncoder().encode('glTF'), ...new Array(120).fill(7)]);
		await storage.put({
			suggestedKey: 'vr-models/a.vrm',
			body: streamOf(model),
			size: model.length,
			contentType: 'application/octet-stream',
			filename: 'a.vrm'
		});
		expect(stored[0].bytes).toEqual(model);
	});

	it('rejects a buffered body whose bytes are not a raster under an image type', async () => {
		const stored: Stored[] = [];
		const { storage, bucket } = storageFor(stored);
		await expect(
			storage.put({
				suggestedKey: 'artwork/d.png',
				body: new TextEncoder().encode('<svg xmlns="x"><script/></svg>'),
				contentType: 'image/png',
				filename: 'd.png'
			})
		).rejects.toThrow(UnscrubbableImageError);
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('rejects an unscrubbable STREAMED body instead of hanging', async () => {
		const stored: Stored[] = [];
		const { storage } = storageFor(stored);
		const truncated = jpegFixture({ truncated: true });
		// The failure this guards against is a put that never settles because the
		// provider is still waiting on a stream the transform has already errored;
		// that one shows up as the runner's own timeout, not as a wrong value.
		await expect(
			storage.put({
				suggestedKey: 'artwork/e.jpg',
				body: streamOf(truncated),
				size: truncated.length,
				contentType: 'image/jpeg',
				filename: 'e.jpg'
			})
		).rejects.toThrow(UnscrubbableImageError);
		expect(stored).toHaveLength(0);
	});

	it('delegates deleteByUrl, owns and deleteOrphans to the provider', async () => {
		const stored: Stored[] = [];
		const { storage, bucket } = storageFor(stored);
		expect(storage.id).toBe('r2');
		expect(storage.owns('https://cdn.test/artwork/a.jpg')).toBe(true);
		await storage.deleteByUrl('https://cdn.test/artwork/a.jpg');
		expect(bucket.delete).toHaveBeenCalledWith('artwork/a.jpg');
		expect(await storage.deleteOrphans([])).toBe(0);
		expect(bucket.list).toHaveBeenCalled();
	});
});
