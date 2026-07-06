import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cdnImage } from '$lib';

// Guards the sona#97 LCP fix: the gallery detail page must render the CDN
// transform (width 1200) — never the raw multi-MB original — as its preview
// image, with intrinsic width/height (no CLS) and fetchpriority on the visible
// (LCP) img. The suite is pure-TS with no component mounting, so the template
// guarantees are asserted against the page source, in the same spirit as
// reactivity-guard.test.ts.

const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const previewImgs = pageSrc.match(/<img[^>]*cdnImage\(image\.imageUrl, 1200\)[^>]*\/>/g) ?? [];

describe('gallery detail LCP image (sona#97)', () => {
	it('never renders the untransformed original in an <img>', () => {
		expect(pageSrc).not.toMatch(/<img[^>]*src=\{image\.imageUrl\}/);
	});

	it('both preview imgs (NSFW-blurred + visible) use the 1200px CDN transform with intrinsic dimensions', () => {
		expect(previewImgs).toHaveLength(2);
		for (const img of previewImgs) {
			expect(img).toContain('width={image.width}');
			expect(img).toContain('height={image.height}');
		}
	});

	it('exactly the visible (non-blurred) img carries fetchpriority="high"', () => {
		const high = previewImgs.filter((img) => img.includes('fetchpriority="high"'));
		expect(high).toHaveLength(1);
		expect(high[0]).not.toContain('blurred');
	});

	it('the preview CSS keeps height auto so the height attribute cannot distort the scaled img', () => {
		const rule = pageSrc.match(/\.image-preview img \{[^}]*\}/);
		expect(rule?.[0]).toContain('height: auto;');
	});

	it('cdnImage(…, 1200) produces the CF transform URL outside dev', () => {
		vi.stubEnv('DEV', false);
		try {
			expect(cdnImage('https://cdn.example.com/foo.png', 1200)).toBe(
				'/cdn-cgi/image/width=1200,quality=75,fit=scale-down,format=auto,anim=false/https://cdn.example.com/foo.png'
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
