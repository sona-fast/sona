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

// R3-T1 source-pins: five behaviors of the detail page that nothing executed.
// Same precedent as the NSFW pins above — each is a one-line condition whose
// silent loss degrades the page without failing any other test.
describe('VR detail media-strip and license wiring (SONA-124 R3-T1)', () => {
	it('video thumbs load lazily: preload="none" until the observer upgrades AND load()s', () => {
		// The strip <video> mounts fetch-free…
		expect(pageSrc).toMatch(/<video[^>]*\bpreload="none"[^>]*use:videoThumb=\{i\}/s);
		// …and the IntersectionObserver upgrade must ALSO call load(): flipping
		// preload after the element settled on none doesn't reliably start the
		// metadata fetch on its own.
		expect(pageSrc).toContain("video.preload = 'metadata';");
		expect(pageSrc).toContain('video.load();');
		expect(pageSrc).toContain('thumbObserver?.unobserve(video);');
	});

	it('the strip is disabled while the 3D stage is up (R2-D12)', () => {
		// Both thumb buttons share the condition, fed by the viewer's bound state.
		expect(pageSrc).toContain('bind:active={viewerActive}');
		const disabled = pageSrc.match(/disabled=\{viewerActive\}/g) ?? [];
		expect(disabled).toHaveLength(2);
	});

	it('duration badges skip non-finite durations and unknown entries (R2-D4)', () => {
		// MediaRecorder WebMs declare Infinity — an "Infinity:NaN" badge is worse
		// than none, so the note guard and the render condition must both hold.
		expect(pageSrc).toContain('if (Number.isFinite(el.duration))');
		expect(pageSrc).toContain('{#if durations[i] !== undefined}');
	});

	it('the main video player is default-silent (muted, like the thumbs)', () => {
		expect(pageSrc).toMatch(/<video src=\{current\.url\}[^>]*\bcontrols\b[^>]*\bmuted\b/);
	});

	it('the CC BY badge links the deed (CC BY 4.0 §3(a)(1)(C))', () => {
		expect(pageSrc).toContain("{#if avatar.license === 'cc-by'}");
		expect(pageSrc).toContain('href="https://creativecommons.org/licenses/by/4.0/"');
		expect(pageSrc).toContain('rel="license noopener"');
	});
});
