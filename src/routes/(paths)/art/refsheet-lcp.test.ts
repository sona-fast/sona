import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the /art ref-sheet LCP treatment (perf): the ref sheet is the page's
// largest-paint element, so it must go through the CDN transform (never the raw
// multi-MB original), carry intrinsic width/height (no CLS), fetchpriority=high,
// and a raw-URL fallback — the same discipline as the gallery-detail hero.
const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('/art ref-sheet LCP markup', () => {
	// Two renders since SONA-18 — the shielded (blurred) one and the plain one.
	// Whichever branch a visitor gets is the LCP element, so both must carry the
	// full contract; asserting only the first would let the other drift.
	const imgs = pageSrc.match(/<img[\s\S]*?refSheetSrc\(data\.refSheet[\s\S]*?\/>/g) ?? [];

	it('renders the ref sheet in both the shielded and the plain branch', () => {
		expect(imgs).toHaveLength(2);
	});

	it('transforms the ref-sheet image through the CDN, never the raw original', () => {
		// The transform now comes from refSheetSrc (see ref-sheet-image.ts, which
		// unit-tests it down to the cdnImage call) rather than an inline width.
		for (const img of imgs) {
			expect(img).toContain('src={refSheetSrc(data.refSheet.imageUrl)}');
		}
		expect(pageSrc).not.toMatch(/<img[^>]*\ssrc=\{data\.refSheet\.imageUrl\}/);
	});

	it('offers the responsive variants rather than one fixed width', () => {
		for (const img of imgs) {
			expect(img).toContain('srcset={refSheetSrcset(data.refSheet.imageUrl)}');
			expect(img).toContain('sizes={refSheetSizes(data.refSheet.imageUrl)}');
		}
		// A bare fixed-width transform sends every viewport the same pixels.
		expect(pageSrc).not.toMatch(/src=\{cdnImage\(data\.refSheet\.imageUrl[^)]*\)\}/);
	});

	it('prioritizes the LCP fetch, reserves its box, and keeps a raw-URL fallback', () => {
		for (const img of imgs) {
			expect(img).toContain('fetchpriority="high"');
			expect(img).toContain('decoding="async"');
			expect(img).toContain('width={data.refSheet.width}');
			expect(img).toContain('height={data.refSheet.height}');
			expect(img).toContain('use:rawFallback={data.refSheet.imageUrl}');
		}
	});
});
