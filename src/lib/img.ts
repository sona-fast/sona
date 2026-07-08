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
		// srcset would override a swapped src, so it goes too.
		img.removeAttribute('srcset');
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
