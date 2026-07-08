import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { cdnImage } from '$lib';
import { heroSrc, heroSrcset, heroSizes, isAnimatedSource, variantThumbSrc, rawFallback } from './hero-image';

// Guards the sona#97 LCP fix: the gallery detail page must request the CDN
// transform — never the raw multi-MB original — as its DEFAULT preview src,
// with intrinsic width/height (no CLS) and fetchpriority on whichever hero img
// renders (on NSFW pages the blurred one IS the LCP element). The raw URL is
// legitimate only as (a) the animated-GIF bypass (GIFs are served raw — off-zone
// GIFs 403 the transform) and (b) the runtime fallback when the transform 403s
// on off-zone sources. Template guarantees are asserted against the page source, in the
// same spirit as reactivity-guard.test.ts; the src selection and fallback
// logic are unit-tested via hero-image.ts.

const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const heroImgs = pageSrc.match(/<img[^>]*heroSrc\(image\.imageUrl\)[^>]*\/>/g) ?? [];

describe('gallery detail hero markup (sona#97)', () => {
	it('never uses the untransformed original as a default <img> src', () => {
		expect(pageSrc).not.toMatch(/<img[^>]*src=\{\s*image\.imageUrl\s*\}/);
	});

	it('both hero imgs (NSFW-blurred + visible) use heroSrc/srcset/sizes with intrinsic dimensions', () => {
		expect(heroImgs).toHaveLength(2);
		for (const img of heroImgs) {
			expect(img).toContain('src={heroSrc(image.imageUrl)}');
			expect(img).toContain('srcset={heroSrcset(image.imageUrl)}');
			expect(img).toContain('sizes={heroSizes(image.imageUrl)}');
			expect(img).toContain('width={image.width}');
			expect(img).toContain('height={image.height}');
		}
	});

	it('whichever hero renders carries fetchpriority="high" and the raw-URL fallback action', () => {
		for (const img of heroImgs) {
			expect(img).toContain('fetchpriority="high"');
			expect(img).toContain('use:rawFallback={image.imageUrl}');
		}
	});

	it('the variant-strip tile routes its raw-imageUrl fallback through the CDN too', () => {
		expect(pageSrc).toContain('src={variant.thumbnailUrl || variantThumbSrc(variant.imageUrl)}');
		expect(pageSrc).not.toMatch(/src=\{\s*variant\.thumbnailUrl\s*\|\|\s*variant\.imageUrl\s*\}/);
	});

	it('the hero CSS keeps height:auto — without it the intrinsic height attribute fixes the rendered height while CSS scales width, distorting every hero', () => {
		const rule = pageSrc.match(/\.image-preview img \{[^}]*\}/)?.[0];
		expect(rule).toBeDefined();
		expect(rule).toContain('height: auto;');
	});
});

describe('hero src selection', () => {
	beforeEach(() => vi.stubEnv('DEV', false));
	afterEach(() => vi.unstubAllEnvs());

	const png = 'https://cdn.example.com/foo.png';
	const gif = 'https://cdn.example.com/anim.gif';

	it('static sources get the 1200px/q80 CDN transform by default', () => {
		expect(heroSrc(png)).toBe(cdnImage(png, 1200, 80));
		// Loose anchor so the transform's presence stays pinned even if the
		// cdnImage comparison above ever degenerates (e.g. both sides raw).
		expect(heroSrc(png)).toContain('width=1200');
		expect(heroSrc(png)).not.toBe(png);
	});

	it('offers 800/1200/1600 width variants with hero sizes', () => {
		expect(heroSrcset(png)).toBe(
			[800, 1200, 1600].map((w) => `${cdnImage(png, w, 80)} ${w}w`).join(', ')
		);
		expect(heroSizes(png)).toBe(
			'(max-width: 768px) 100vw, (max-width: 1280px) calc(100vw - 468px), 810px'
		);
	});

	it('animated GIFs bypass the transform entirely (served raw — off-zone GIFs 403)', () => {
		expect(isAnimatedSource(gif)).toBe(true);
		expect(isAnimatedSource(`${gif}?v=2`)).toBe(true);
		expect(isAnimatedSource(png)).toBe(false);
		expect(heroSrc(gif)).toBe(gif);
		expect(heroSrcset(gif)).toBeUndefined();
		expect(heroSizes(gif)).toBeUndefined();
	});

	it('variant tiles get the 168px transform, with the same GIF bypass', () => {
		expect(variantThumbSrc(png)).toBe(cdnImage(png, 168));
		expect(variantThumbSrc(png)).toContain('width=168');
		expect(variantThumbSrc(gif)).toBe(gif);
	});
});

describe('rawFallback action (off-zone 403 → raw original)', () => {
	// Minimal stand-in for an <img> — the node test env has no DOM. Only the
	// surface the action touches is stubbed.
	function stubImg(init: { src: string; srcset?: string; complete?: boolean; naturalWidth?: number }) {
		const attrs = new Map<string, string>([['src', init.src]]);
		if (init.srcset !== undefined) attrs.set('srcset', init.srcset);
		const listeners = new Set<() => void>();
		let srcWrites = 0;
		return {
			complete: init.complete ?? false,
			naturalWidth: init.naturalWidth ?? 1,
			getAttribute: (k: string) => attrs.get(k) ?? null,
			setAttribute: (k: string, v: string) => {
				if (k === 'src') srcWrites++;
				attrs.set(k, v);
			},
			removeAttribute: (k: string) => void attrs.delete(k),
			hasAttribute: (k: string) => attrs.has(k),
			addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
			removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
			fireError: () => listeners.forEach((fn) => fn()),
			listenerCount: () => listeners.size,
			srcWriteCount: () => srcWrites
		};
	}

	const raw = 'https://app.ufs.sh/f/abc';
	const transformed = `/cdn-cgi/image/width=1200,quality=80,fit=scale-down,format=auto/${raw}`;

	it('swaps a failing transformed src to the raw URL and drops srcset', () => {
		const img = stubImg({ src: transformed, srcset: `${transformed} 1200w` });
		rawFallback(img as unknown as HTMLImageElement, raw);
		img.fireError();
		expect(img.getAttribute('src')).toBe(raw);
		expect(img.hasAttribute('srcset')).toBe(false);
	});

	it('an error on the raw URL itself is terminal — the swap runs exactly once across two errors', () => {
		const img = stubImg({ src: transformed });
		rawFallback(img as unknown as HTMLImageElement, raw);
		img.fireError();
		img.fireError();
		expect(img.getAttribute('src')).toBe(raw);
		// Counting writes (not just the final value) is what catches a deleted
		// terminal guard: a second swap re-sets the same src.
		expect(img.srcWriteCount()).toBe(1);
	});

	it('update() retargets the fallback: an error after update swaps to the NEW raw URL', () => {
		const img = stubImg({ src: transformed });
		const action = rawFallback(img as unknown as HTMLImageElement, raw);
		const newRaw = 'https://app.ufs.sh/f/def';
		action.update(newRaw);
		img.fireError();
		expect(img.getAttribute('src')).toBe(newRaw);
	});

	it('swaps an img that already failed BEFORE hydration (complete, zero naturalWidth)', () => {
		const img = stubImg({ src: transformed, complete: true, naturalWidth: 0 });
		rawFallback(img as unknown as HTMLImageElement, raw);
		expect(img.getAttribute('src')).toBe(raw);
	});

	it('leaves a successfully loaded img alone and detaches on destroy', () => {
		const img = stubImg({ src: transformed, complete: true, naturalWidth: 800 });
		const action = rawFallback(img as unknown as HTMLImageElement, raw);
		expect(img.getAttribute('src')).toBe(transformed);
		action.destroy();
		expect(img.listenerCount()).toBe(0);
	});
});
