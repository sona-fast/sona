import { describe, it, expect, vi } from 'vitest';
import { isAnimatedRaster, sniffAnimatedFromUrl } from './animated-raster';

// --- byte builders -----------------------------------------------------------

function ascii(text: string): number[] {
	return [...text].map((c) => c.charCodeAt(0));
}

/** Minimal RIFF/WEBP file whose first chunk is `fourcc` with `payload`. */
function webp(fourcc: string, payload: number[]): Uint8Array {
	const chunk = [...ascii(fourcc), payload.length, 0, 0, 0, ...payload];
	const size = 4 + chunk.length;
	return new Uint8Array([...ascii('RIFF'), size & 0xff, (size >> 8) & 0xff, 0, 0, ...ascii('WEBP'), ...chunk]);
}

/** VP8X payload: flags byte + 3 reserved + 3 width + 3 height = 10 bytes. */
function vp8x(flags: number): number[] {
	return [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

const GIF_HEADER = [...ascii('GIF89a'), 2, 0, 2, 0, 0x00, 0, 0]; // no global color table
// Image descriptor for a 2x2 frame with no local color table, plus a 1-byte
// LZW minimum code size and a single empty-terminated data sub-block chain.
const GIF_FRAME = [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0x00, 0x02, 1, 0x4c, 0x00];
const GIF_TRAILER = [0x3b];
// Graphic-control extension (the block every animated GIF carries per frame).
const GIF_GCE = [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00];

// --- isAnimatedRaster --------------------------------------------------------

describe('isAnimatedRaster', () => {
	it('detects an animated WebP (VP8X with the animation bit)', () => {
		expect(isAnimatedRaster(webp('VP8X', vp8x(0x02)))).toBe(true);
	});

	it('treats a VP8X WebP without the animation bit as static', () => {
		// 0x08 = EXIF flag — extended layout, but not animated.
		expect(isAnimatedRaster(webp('VP8X', vp8x(0x08)))).toBe(false);
	});

	it('treats simple lossy/lossless WebP as static (cannot animate)', () => {
		expect(isAnimatedRaster(webp('VP8 ', [0, 0, 0, 0]))).toBe(false);
		expect(isAnimatedRaster(webp('VP8L', [0, 0, 0, 0]))).toBe(false);
	});

	it('detects a multi-frame GIF', () => {
		const gif = new Uint8Array([...GIF_HEADER, ...GIF_GCE, ...GIF_FRAME, ...GIF_GCE, ...GIF_FRAME, ...GIF_TRAILER]);
		expect(isAnimatedRaster(gif)).toBe(true);
	});

	it('treats a single-frame GIF as static', () => {
		const gif = new Uint8Array([...GIF_HEADER, ...GIF_FRAME, ...GIF_TRAILER]);
		expect(isAnimatedRaster(gif)).toBe(false);
	});

	it('walks a GIF with a global color table', () => {
		// Packed byte 0x91: GCT present, 2 bits/pixel → 4 entries × 3 bytes.
		const header = [...ascii('GIF89a'), 2, 0, 2, 0, 0x91, 0, 0, ...new Array(4 * 3).fill(0)];
		const gif = new Uint8Array([...header, ...GIF_FRAME, ...GIF_FRAME, ...GIF_TRAILER]);
		expect(isAnimatedRaster(gif)).toBe(true);
	});

	it('degrades to static on non-raster and malformed input', () => {
		expect(isAnimatedRaster(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG magic
		expect(isAnimatedRaster(new Uint8Array([]))).toBe(false);
		expect(isAnimatedRaster(new Uint8Array(ascii('GIF89a')))).toBe(false); // truncated
		// Truncated mid-sub-block: the walk runs off the buffer after one frame.
		const gif = new Uint8Array([...GIF_HEADER, 0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0x00, 0x02, 200]);
		expect(isAnimatedRaster(gif)).toBe(false);
	});
});

// --- sniffAnimatedFromUrl ----------------------------------------------------

describe('sniffAnimatedFromUrl', () => {
	const animated = webp('VP8X', vp8x(0x02));

	it('fetches and sniffs an absolute URL', async () => {
		const fetchFn = vi.fn(async () => new Response(animated.buffer as ArrayBuffer));
		await expect(sniffAnimatedFromUrl('https://cdn.example.com/s.webp', fetchFn as typeof fetch)).resolves.toBe(true);
		expect(fetchFn).toHaveBeenCalledWith('https://cdn.example.com/s.webp');
	});

	it('resolves a relative URL against the provided origin', async () => {
		const fetchFn = vi.fn(async () => new Response(animated.buffer as ArrayBuffer));
		await sniffAnimatedFromUrl('/stickers/pack/s.webp', fetchFn as typeof fetch, 'https://site.example');
		expect(fetchFn).toHaveBeenCalledWith('https://site.example/stickers/pack/s.webp');
	});

	it('defaults to static on relative URL without origin, non-2xx, and network error', async () => {
		await expect(sniffAnimatedFromUrl('/relative.webp', vi.fn() as unknown as typeof fetch)).resolves.toBe(false);
		const notFound = vi.fn(async () => new Response('nope', { status: 404 }));
		await expect(sniffAnimatedFromUrl('https://x.example/s.webp', notFound as typeof fetch)).resolves.toBe(false);
		const boom = vi.fn(async () => {
			throw new Error('network');
		});
		await expect(sniffAnimatedFromUrl('https://x.example/s.webp', boom as unknown as typeof fetch)).resolves.toBe(false);
	});
});
