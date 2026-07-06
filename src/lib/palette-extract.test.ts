import { describe, it, expect } from 'vitest';
import { extractPalette, type PixelSource } from './palette-extract';

// Synthetic-pixel helpers: images start fully transparent (alpha 0), and
// fillRect paints an opaque flat-color region.
function blank(width: number, height: number): PixelSource {
	return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function fillRect(
	img: PixelSource,
	x0: number,
	y0: number,
	w: number,
	h: number,
	[r, g, b, a = 255]: number[]
) {
	for (let y = y0; y < y0 + h; y++) {
		for (let x = x0; x < x0 + w; x++) {
			const i = (y * img.width + x) * 4;
			img.data[i] = r;
			img.data[i + 1] = g;
			img.data[i + 2] = b;
			img.data[i + 3] = a;
		}
	}
}

describe('extractPalette', () => {
	it('ranks flat-color regions by area (largest first)', () => {
		const img = blank(40, 40); // transparent border → no background exclusion
		fillRect(img, 2, 2, 20, 20, [208, 64, 48]); // 400 px red
		fillRect(img, 25, 2, 10, 10, [48, 160, 80]); // 100 px green
		fillRect(img, 25, 20, 5, 5, [40, 80, 200]); // 25 px blue

		expect(extractPalette(img)).toEqual(['#D04030', '#30A050', '#2850C8']);
	});

	it('excludes a COLORED border-ring background, not just near-white/black', () => {
		const img = blank(40, 40);
		fillRect(img, 0, 0, 40, 40, [180, 168, 220]); // flat lavender backdrop
		fillRect(img, 10, 8, 20, 20, [80, 60, 130]); // darker antler-purple character
		fillRect(img, 14, 30, 6, 6, [40, 180, 160]); // teal accent

		const result = extractPalette(img);
		expect(result).not.toContain('#B4A8DC'); // background gone
		// The darker purple is near the lavender in hue but far in RGB distance —
		// it must survive as a distinct color (taro's sheet case).
		expect(result).toEqual(['#503C82', '#28B4A0']);
	});

	it('min-distance dedupes near-identical fur shades but keeps a small accent', () => {
		const img = blank(40, 40);
		fillRect(img, 2, 2, 30, 20, [208, 64, 48]); // large red
		fillRect(img, 2, 25, 20, 10, [200, 68, 40]); // near-identical red (dist ≈ 12)
		fillRect(img, 30, 30, 5, 5, [48, 192, 176]); // tiny teal accent (25 px)

		const result = extractPalette(img);
		expect(result[0]).toBe('#D04030');
		expect(result).toContain('#30C0B0'); // accent survives
		expect(result).not.toContain('#C84428'); // shade within minDistance is folded
	});

	it('skips transparent pixels (alpha < 128)', () => {
		const img = blank(20, 20);
		fillRect(img, 2, 2, 16, 8, [255, 0, 0, 0]); // "red" but fully transparent
		fillRect(img, 2, 11, 8, 4, [40, 80, 200]); // small opaque blue

		expect(extractPalette(img)).toEqual(['#2850C8']);
	});

	it('returns the most-common ACTUAL pixel of a bucket, never an average', () => {
		const img = blank(12, 12);
		// Both colors land in the same 4-bit bucket (0x10–0x1F per channel).
		fillRect(img, 1, 1, 10, 10, [0x1f, 0x1f, 0x1f]); // 100 px
		fillRect(img, 1, 1, 6, 10, [0x10, 0x10, 0x10]); // 60 of them overwritten → majority

		// Mode pixel is #101010; a bucket average would invent ~#161616.
		expect(extractPalette(img)).toEqual(['#101010']);
	});

	it('returns at most `count` colors', () => {
		const img = blank(40, 40);
		// Seven well-separated colors, 5x5 each.
		const colors = [
			[208, 64, 48],
			[48, 160, 80],
			[40, 80, 200],
			[240, 200, 40],
			[160, 40, 200],
			[40, 200, 220],
			[120, 90, 60]
		];
		colors.forEach((c, i) => fillRect(img, 2 + (i % 4) * 9, 2 + Math.floor(i / 4) * 9, 5, 5, c));

		expect(extractPalette(img, { count: 5 })).toHaveLength(5);
		expect(extractPalette(img, { count: 3 })).toHaveLength(3);
	});
});
