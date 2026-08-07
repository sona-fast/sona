import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cdnImage, isAnimatedSource } from '$lib';
import { refSheetSrc, refSheetSrcset, refSheetSizes } from './ref-sheet-image';

// The /art ref sheet is that page's LCP element but was rendered at a single
// fixed width, so every visitor downloaded the 1200px transform — roughly twice
// the pixels the 544px slot needs on a 1x display, and far more on a phone.
// Mirrors the gallery hero's srcset treatment; the markup that wires these
// helpers up is guarded in refsheet-lcp.test.ts.

describe('ref-sheet src selection', () => {
	beforeEach(() => vi.stubEnv('DEV', false));
	afterEach(() => vi.unstubAllEnvs());

	const png = 'https://cdn.example.com/ref.png';
	const gif = 'https://cdn.example.com/ref.gif';

	it('uses a mid-ladder transform as the default src', () => {
		// The srcset fallback, so it belongs to the ladder rather than sitting a
		// fourth width beside it.
		expect(refSheetSrc(png)).toBe(cdnImage(png, 1100, 75));
		expect(refSheetSrc(png)).toContain('width=1100');
		expect(refSheetSrc(png)).not.toBe(png);
	});

	it('offers 600/1100/1600 width variants sized for the 544px slot', () => {
		// 600w covers the slot at 1x and 1100w at 2x; the old 800/1200/1600 ladder
		// was the gallery hero's, where the column is ~810px, so the smallest
		// candidate a phone could pick was already 1.5x more pixels than it shows.
		expect(refSheetSrcset(png)).toBe(
			[600, 1100, 1600].map((w) => `${cdnImage(png, w, 75)} ${w}w`).join(', ')
		);
	});

	it('sizes the slot to the 600px paths shell, not the gallery hero column', () => {
		// .paths-page caps at 600px and .section pads 28px a side → 544px, and
		// 100vw - 56px below that. Getting this wrong is invisible in the markup
		// but makes the browser pick the wrong candidate on every load.
		expect(refSheetSizes(png)).toBe('(max-width: 600px) calc(100vw - 56px), 544px');
	});

	it('animated GIFs get no srcset at all', () => {
		// cdnImage returns a GIF unchanged, so a srcset built from it would list
		// the identical URL three times under three different width descriptors.
		expect(isAnimatedSource(gif)).toBe(true);
		expect(refSheetSrc(gif)).toBe(gif);
		expect(refSheetSrcset(gif)).toBeUndefined();
		expect(refSheetSizes(gif)).toBeUndefined();
	});
});
