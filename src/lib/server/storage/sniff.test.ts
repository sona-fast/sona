import { describe, it, expect } from 'vitest';
import { sniffImageType } from './sniff';
import { isAllowedImageType } from './index';

const enc = new TextEncoder();

// Minimal valid leading bytes for each raster type.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = enc.encode('GIF89a....');
const WEBP = (() => {
	const b = new Uint8Array(16);
	b.set(enc.encode('RIFF'), 0);
	b.set(enc.encode('WEBP'), 8);
	return b;
})();
const AVIF = (() => {
	// [size=0x1c]"ftyp""avif"...
	const b = new Uint8Array([0, 0, 0, 0x1c]);
	return new Uint8Array([...b, ...enc.encode('ftyp'), ...enc.encode('avif'), ...enc.encode('mif1')]);
})();
// mif1-major AVIF: the `avif` brand lives in compatible_brands (offset 16+), not
// as the major_brand — a spec-valid MIAF/HEIF-derived AVIF. Box layout: size,
// "ftyp", "mif1" (major_brand), minor_version, then compatible_brands "mif1","avif".
const AVIF_MIF1 = new Uint8Array([
	0, 0, 0, 0x18, // box size = 24
	...enc.encode('ftyp'),
	...enc.encode('mif1'), // major_brand
	0, 0, 0, 0, // minor_version
	...enc.encode('mif1'), // compatible_brands[0] @ offset 16
	...enc.encode('avif') // compatible_brands[1] @ offset 20
]);

describe('sniffImageType', () => {
	it('detects each allowed raster type from its magic bytes', () => {
		expect(sniffImageType(PNG)).toBe('image/png');
		expect(sniffImageType(JPEG)).toBe('image/jpeg');
		expect(sniffImageType(GIF)).toBe('image/gif');
		expect(sniffImageType(WEBP)).toBe('image/webp');
		expect(sniffImageType(AVIF)).toBe('image/avif');
	});

	it('accepts a mif1-major AVIF whose avif brand is in compatible_brands', () => {
		// Regression: the upload site used to sniff only 16 bytes, so this brand
		// (at offset 20) was invisible and a valid AVIF returned null -> 415.
		expect(sniffImageType(AVIF_MIF1)).toBe('image/avif');
		expect(isAllowedImageType(sniffImageType(AVIF_MIF1))).toBe(true);
	});

	it('returns null for non-raster payloads (HTML / SVG / text)', () => {
		expect(sniffImageType(enc.encode('<!DOCTYPE html><script>alert(1)</script>'))).toBeNull();
		expect(sniffImageType(enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
		expect(sniffImageType(enc.encode('just some plain text'))).toBeNull();
		expect(sniffImageType(new Uint8Array([]))).toBeNull();
	});

	it('rejects a spoofed image content-type when the bytes are HTML', () => {
		// This is the call-site check: an HTML payload uploaded as image/png must
		// fail the allowlist test because its sniffed type is null.
		const htmlBytes = enc.encode('<html><body>not an image</body></html>');
		expect(isAllowedImageType(sniffImageType(htmlBytes))).toBe(false);
	});

	it('accepts real raster bytes through the same allowlist gate', () => {
		expect(isAllowedImageType(sniffImageType(PNG))).toBe(true);
		expect(isAllowedImageType(sniffImageType(WEBP))).toBe(true);
	});
});
