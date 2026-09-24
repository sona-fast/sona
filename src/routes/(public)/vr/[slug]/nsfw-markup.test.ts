import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the VR detail page's strip-thumb NSFW blur, the reveal
// handler, the poster's responsive-image contract (R2-T4), and the CC BY deed
// link. The main-frame overlay is covered in a browser by
// tests/e2e/vr-avatar.spec.ts; the three strip-thumb surfaces have nothing else
// executing them, and a dropped condition fails silently (mature content simply
// renders).

const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('VR detail NSFW gate markup (SONA-124 R2-T4)', () => {
	it('blurs ALL THREE strip-thumb surfaces on the same reveal condition', () => {
		// Poster thumb <img>, video thumb <video>, image thumb <img> — one shared
		// condition so no thumb can leak an unblurred preview.
		const blurredThumbs = pageSrc.match(/class:blurred-thumb=\{avatar\.nsfw && !revealed\}/g) ?? [];
		expect(blurredThumbs).toHaveLength(3);
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

describe('VR detail license wiring (SONA-124 R3-T1)', () => {
	it('the CC BY badge links the deed (CC BY 4.0 §3(a)(1)(C))', () => {
		expect(pageSrc).toContain("{#if avatar.license === 'cc-by'}");
		expect(pageSrc).toContain('href="https://creativecommons.org/licenses/by/4.0/"');
		expect(pageSrc).toContain('rel="license noopener"');
	});
});
