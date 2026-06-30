import { describe, it, expect } from 'vitest';
import { isAllowedImageType, isAllowedStickerType, extFromContentType } from './index';

// These allow-lists ARE a security boundary: stored objects are served from
// cdn.sparky.ink with their stored content-type, bypassing the worker's
// X-Content-Type-Options:nosniff. So nothing that could execute as active content
// in that origin (svg+xml, html) may pass — for either images or stickers.

describe('isAllowedImageType (artwork/fursuit — raster only)', () => {
	it('allows safe raster types', () => {
		for (const t of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']) {
			expect(isAllowedImageType(t)).toBe(true);
		}
	});

	it('refuses active/document types and stays raster-only', () => {
		for (const t of ['image/svg+xml', 'text/html', 'application/json', 'video/webm', 'application/javascript']) {
			expect(isAllowedImageType(t)).toBe(false);
		}
		expect(isAllowedImageType(null)).toBe(false);
		expect(isAllowedImageType(undefined)).toBe(false);
	});

	it('ignores content-type parameters', () => {
		expect(isAllowedImageType('image/png; charset=binary')).toBe(true);
	});
});

describe('isAllowedStickerType (stickers — raster + webm + lottie json)', () => {
	it('allows the widened sticker set', () => {
		for (const t of ['image/png', 'image/webp', 'image/gif', 'video/webm', 'application/json']) {
			expect(isAllowedStickerType(t)).toBe(true);
		}
	});

	it('still refuses svg/html and other active types', () => {
		for (const t of ['image/svg+xml', 'text/html', 'application/xml', 'application/javascript']) {
			expect(isAllowedStickerType(t)).toBe(false);
		}
		expect(isAllowedStickerType(null)).toBe(false);
	});
});

describe('extFromContentType', () => {
	it('maps the sticker media types to clean extensions', () => {
		expect(extFromContentType('image/webp')).toBe('webp');
		expect(extFromContentType('image/png')).toBe('png');
		expect(extFromContentType('video/webm')).toBe('webm');
		expect(extFromContentType('application/json')).toBe('json');
	});
});
