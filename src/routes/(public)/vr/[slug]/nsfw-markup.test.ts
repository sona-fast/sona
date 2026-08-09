import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the VR detail page's page-level NSFW gate and the poster's
// responsive-image contract (R2-T4), per the lcp-image.test.ts precedent: the
// viewer half of the gate is pinned in VrViewer.test.ts, but the PAGE half —
// the blur overlay and the three strip-thumb surfaces — had nothing executing
// it, and a dropped condition fails silently (mature content simply renders).

const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('VR detail NSFW gate markup (SONA-124 R2-T4)', () => {
	it('gates the whole main frame on avatar.nsfw && !revealed', () => {
		expect(pageSrc).toContain('{#if avatar.nsfw && !revealed}');
		// The overlay carries the blurred poster + the reveal button.
		expect(pageSrc).toContain('class="blurred"');
		expect(pageSrc).toMatch(/reveal-btn/);
	});

	it('blurs ALL THREE strip-thumb surfaces on the same reveal condition', () => {
		// Poster thumb <img>, video thumb <video>, image thumb <img> — one shared
		// condition so no thumb can leak an unblurred preview.
		const blurredThumbs = pageSrc.match(/class:blurred-thumb=\{avatar\.nsfw && !revealed\}/g) ?? [];
		expect(blurredThumbs).toHaveLength(3);
	});

	it('hands the same gate to the viewer (3D entry point hides until revealed)', () => {
		expect(pageSrc).toContain('nsfw={avatar.nsfw}');
		expect(pageSrc).toContain('{revealed}');
	});

	it('the reveal handler announces and moves focus (button unmounts itself)', () => {
		expect(pageSrc).toMatch(/onclick=\{reveal\}/);
		expect(pageSrc).toContain('mediaFrame?.focus()');
		expect(pageSrc).toContain('<p class="sr-only" role="status">{revealAnnouncement}</p>');
	});
});

describe('VR detail poster responsive contract (P2)', () => {
	// Both poster renders (blurred NSFW overlay + visible) must use the
	// responsive spec — whichever renders is the LCP element.
	const posterImgs = pageSrc.match(/<img[^>]*responsiveSrc\(avatar\.posterUrl, POSTER\)[^>]*\/>/g) ?? [];

	it('both poster imgs carry srcset/sizes, intrinsic dimensions and fetchpriority', () => {
		expect(posterImgs).toHaveLength(2);
		for (const img of posterImgs) {
			expect(img).toContain('srcset={responsiveSrcset(avatar.posterUrl, POSTER)}');
			expect(img).toContain('sizes={responsiveSizes(avatar.posterUrl, POSTER)}');
			expect(img).toContain('width={avatar.posterWidth}');
			expect(img).toContain('height={avatar.posterHeight}');
			expect(img).toContain('fetchpriority="high"');
			expect(img).toContain('use:rawFallback={avatar.posterUrl}');
		}
	});

	it('pins the width ladder and slot sizes of the POSTER spec', () => {
		expect(pageSrc).toContain('widths: [800, 1200, 1600]');
		expect(pageSrc).toContain(
			"sizes: '(max-width: 768px) 100vw, (max-width: 1280px) calc(100vw - 468px), 810px'"
		);
	});

	it('never uses the raw posterUrl as a default <img> src', () => {
		expect(pageSrc).not.toMatch(/<img[^>]*src=\{\s*avatar\.posterUrl\s*\}/);
	});
});
