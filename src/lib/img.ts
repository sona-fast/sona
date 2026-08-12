/**
 * True for animated sources we can identify from the URL alone — today just
 * GIF. Such sources are served raw (bypassing the CDN transform) and skip
 * srcset: GIFs are large and off-zone GIFs 403 the transform anyway. Animated
 * WebP/AVIF can't be told apart from static without the bytes, so they ride the
 * transform instead — which now preserves animation (cdnImage no longer forces
 * anim=false) and resizes them, so they animate without needing detection here.
 *
 * Known gap: UploadThing URLs (`ufs.sh/f/<key>`, legacy `utfs.io`) carry no
 * extension, so GIFs hosted there aren't detected — but the transform 403s on
 * those off-zone sources and rawFallback swaps in the original, so they still
 * animate.
 */
export function isAnimatedSource(url: string): boolean {
	return /\.gif($|[?#])/i.test(url);
}

/**
 * Route an image URL through Cloudflare Image Transformations so grids
 * and thumbnails don't download multi-MB originals. In dev the CF edge
 * isn't available, so fall through to the raw URL.
 *
 * Lives here rather than in $lib/index.ts (which re-exports it, so callers are
 * unaffected) because the responsive builders below need it and importing back
 * from the barrel would make the two modules circular.
 */
export function cdnImage(src: string | null | undefined, width = 800, quality = 75): string {
	if (!src) return '';
	if (import.meta.env.DEV) return src;
	// GIFs bypass the transform and serve their raw original: they're the one
	// animated upload type detectable by extension, and off-zone GIFs
	// (UploadThing, non-resize R2) 403 the transform anyway. Animated WebP/AVIF
	// can't be told from static via URL, so they ride the transform — which
	// preserves animation (no anim=false) and still resizes to `width`. CF caps
	// animated resizing at 50 MP (bigger animations are delivered un-resized but
	// still animated; >100 MP errors → rawFallback swaps in the raw original).
	if (isAnimatedSource(src)) return src;
	return `/cdn-cgi/image/width=${width},quality=${quality},fit=scale-down,format=auto/${src}`;
}

/**
 * The width every gallery-row thumbnail is transformed at — the public gallery
 * grid, the admin image list, and the VR/collections pickers all request it.
 *
 * Sharing ONE width is what keeps this affordable: a transform URL is its own
 * cache key, so every surface asking for 200 reuses the variant the first one
 * generated. A surface that picks its own width spends a fresh Image
 * Transformation per image (the plan allows 5000 unique ones), which is why new
 * thumbnail call sites should use this rather than a hand-picked number.
 */
export const THUMB_WIDTH = 200;

/**
 * Everything that differs between one responsive image and the next: the CDN
 * width ladder to offer, the `sizes` describing the slot those widths land in,
 * the transform quality, and the width the plain `src` fallback uses. The slot
 * measurements are the only route knowledge; the builders below are shared.
 */
export interface ResponsiveImage {
	widths: number[];
	sizes: string;
	quality: number;
	srcWidth: number;
}

/** Default `src`: one CDN transform, or the raw original when animated. */
export function responsiveSrc(url: string, spec: ResponsiveImage): string {
	return isAnimatedSource(url) ? url : cdnImage(url, spec.srcWidth, spec.quality);
}

/**
 * The width variants, or undefined for an animated source: cdnImage returns a
 * GIF unchanged, so a ladder built from one would list the identical URL under
 * every width descriptor and let the browser pick a descriptor that describes
 * nothing.
 *
 * In dev the candidates ARE all identical for every source, animated or not —
 * cdnImage returns the raw URL under import.meta.env.DEV, since there is no CF
 * edge to transform. Expected; it is the GIF case above that needs the branch.
 */
export function responsiveSrcset(url: string, spec: ResponsiveImage): string | undefined {
	if (isAnimatedSource(url)) return undefined;
	return spec.widths.map((w) => `${cdnImage(url, w, spec.quality)} ${w}w`).join(', ');
}

/** `sizes` for the srcset; omitted when animated (there is no srcset to size). */
export function responsiveSizes(url: string, spec: ResponsiveImage): string | undefined {
	return isAnimatedSource(url) ? undefined : spec.sizes;
}

/**
 * Svelte action: fall back to the raw original when the (transformed) src
 * fails to load. Cloudflare Image Transformations refuse off-zone source URLs
 * with 403 (see the admin/stickers avatar note), so on providers like
 * UploadThing the transform URL never renders; this also covers R2's
 * no-r2PublicUrl relative-URL edge. An SSR'd img can fail BEFORE hydration and
 * never re-fire `error`, so an already-settled broken img (complete with zero
 * naturalWidth) is swapped at mount too. One swap, no retries: once src IS the
 * raw URL, a further error is terminal.
 */
export function rawFallback(img: HTMLImageElement, raw: string) {
	let rawUrl = raw;
	const onError = () => {
		if (!rawUrl || img.getAttribute('src') === rawUrl) return;
		// srcset would override a swapped src, so it goes too — and `sizes` with
		// it, since a sizes without a srcset describes a slot for candidates that
		// no longer exist.
		img.removeAttribute('srcset');
		img.removeAttribute('sizes');
		img.setAttribute('src', rawUrl);
	};
	img.addEventListener('error', onError);
	if (img.complete && img.naturalWidth === 0) onError();
	return {
		update(newRaw: string) {
			rawUrl = newRaw;
		},
		destroy() {
			img.removeEventListener('error', onError);
		}
	};
}
