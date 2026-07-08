import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Guards the /art ref-sheet LCP treatment (perf): the ref sheet is the page's
// largest-paint element, so it must go through the CDN transform (never the raw
// multi-MB original), carry intrinsic width/height (no CLS), fetchpriority=high,
// and a raw-URL fallback — the same discipline as the gallery-detail hero.
const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('/art ref-sheet LCP markup', () => {
	it('transforms the ref-sheet image through cdnImage, never the raw original', () => {
		expect(pageSrc).toContain('src={cdnImage(data.refSheet.imageUrl, 1200)}');
		expect(pageSrc).not.toMatch(/<img[^>]*\ssrc=\{data\.refSheet\.imageUrl\}/);
	});

	it('prioritizes the LCP fetch, reserves its box, and keeps a raw-URL fallback', () => {
		const img = pageSrc.match(/<img[\s\S]*?cdnImage\(data\.refSheet[\s\S]*?\/>/)?.[0] ?? '';
		expect(img).toContain('fetchpriority="high"');
		expect(img).toContain('decoding="async"');
		expect(img).toContain('width={data.refSheet.width}');
		expect(img).toContain('height={data.refSheet.height}');
		expect(img).toContain('use:rawFallback={data.refSheet.imageUrl}');
	});
});
