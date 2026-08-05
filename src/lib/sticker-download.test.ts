import { describe, it, expect } from 'vitest';
import { originalExt, stickerDownloadOptions } from './sticker-download';

const CDN = 'https://cdn.example.com/stickers/pack';

describe('originalExt', () => {
	it('maps video and Lottie to their fixed extensions', () => {
		expect(originalExt({ format: 'video', imageUrl: `${CDN}/a.webm`, isAnimated: true })).toBe('webm');
		expect(originalExt({ format: 'animated', imageUrl: `${CDN}/a.json`, isAnimated: true })).toBe('json');
	});

	it('reads the raster extension from the stored URL', () => {
		expect(originalExt({ format: 'webp', imageUrl: `${CDN}/a.webp`, isAnimated: false })).toBe('webp');
		// GIFs are stored under format 'png' (schema enum has no 'gif').
		expect(originalExt({ format: 'png', imageUrl: `${CDN}/a.gif`, isAnimated: false })).toBe('gif');
		// Relative URL still parses.
		expect(originalExt({ format: 'png', imageUrl: '/stickers/pack/a.png', isAnimated: false })).toBe('png');
	});

	it('falls back to the format when the URL has no extension', () => {
		expect(originalExt({ format: 'webp', imageUrl: `${CDN}/nokey`, isAnimated: false })).toBe('webp');
		expect(originalExt({ format: 'png', imageUrl: `${CDN}/nokey`, isAnimated: false })).toBe('png');
	});
});

describe('stickerDownloadOptions', () => {
	it('offers original + PNG for a static non-PNG raster', () => {
		expect(stickerDownloadOptions({ format: 'webp', imageUrl: `${CDN}/a.webp`, isAnimated: false })).toEqual([
			{ kind: 'original', ext: 'webp' },
			{ kind: 'png', ext: 'png' }
		]);
		expect(stickerDownloadOptions({ format: 'png', imageUrl: `${CDN}/a.gif`, isAnimated: false })).toEqual([
			{ kind: 'original', ext: 'gif' },
			{ kind: 'png', ext: 'png' }
		]);
	});

	it('omits PNG when the original already is PNG', () => {
		expect(stickerDownloadOptions({ format: 'png', imageUrl: `${CDN}/a.png`, isAnimated: false })).toEqual([
			{ kind: 'original', ext: 'png' }
		]);
	});

	it('omits PNG for animated rasters — conversion would flatten them', () => {
		expect(stickerDownloadOptions({ format: 'webp', imageUrl: `${CDN}/a.webp`, isAnimated: true })).toEqual([
			{ kind: 'original', ext: 'webp' }
		]);
		expect(stickerDownloadOptions({ format: 'png', imageUrl: `${CDN}/a.gif`, isAnimated: true })).toEqual([
			{ kind: 'original', ext: 'gif' }
		]);
	});

	it('offers only the native format for video and Lottie', () => {
		expect(stickerDownloadOptions({ format: 'video', imageUrl: `${CDN}/a.webm`, isAnimated: true })).toEqual([
			{ kind: 'original', ext: 'webm' }
		]);
		expect(stickerDownloadOptions({ format: 'animated', imageUrl: `${CDN}/a.json`, isAnimated: true })).toEqual([
			{ kind: 'original', ext: 'json' }
		]);
	});
});
