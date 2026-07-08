import { cdnImage, isAnimatedSource, rawFallback } from '$lib';

// Re-exported so this route's consumers (detail +page.svelte, lcp-image.test)
// keep their `./hero-image` import path; the definitions now live in $lib/img.
export { isAnimatedSource, rawFallback };

// The detail-page hero is the 1fr column beside the 380px meta panel:
// full-width on mobile, then calc(100vw - 468px) (380px meta column + 40px
// grid gap + 48px .image-page padding) until the 1280px container cap, where
// it settles at ~810 CSS px.
const HERO_SIZES = '(max-width: 768px) 100vw, (max-width: 1280px) calc(100vw - 468px), 810px';
const HERO_WIDTHS = [800, 1200, 1600];
const HERO_QUALITY = 80;

/** Default hero src: the 1200px CDN transform, or the raw original when animated. */
export function heroSrc(url: string): string {
	return isAnimatedSource(url) ? url : cdnImage(url, 1200, HERO_QUALITY);
}

/** Responsive width variants for the hero; none for animated (raw URL only). */
export function heroSrcset(url: string): string | undefined {
	if (isAnimatedSource(url)) return undefined;
	return HERO_WIDTHS.map((w) => `${cdnImage(url, w, HERO_QUALITY)} ${w}w`).join(', ');
}

/** `sizes` for the hero srcset; omitted when animated (no srcset to size). */
export function heroSizes(url: string): string | undefined {
	return isAnimatedSource(url) ? undefined : HERO_SIZES;
}

/** 84px variant-strip tile (168 = 2x for DPR), with the same animated bypass. */
export function variantThumbSrc(url: string): string {
	return isAnimatedSource(url) ? url : cdnImage(url, 168);
}
