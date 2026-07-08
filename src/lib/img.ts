/**
 * Animated sources must bypass the CDN transform: cdnImage hardcodes
 * anim=false, which would freeze the artwork to its first frame. Same rule as
 * StickerMedia, which keeps animated formats out of cdnImage entirely. GIF is
 * the only allowed upload type whose animation is detectable from the URL
 * (animated WebP/AVIF can't be told apart from static without the bytes).
 *
 * Known gap: UploadThing URLs (`ufs.sh/f/<key>`, legacy `utfs.io`) carry no
 * extension, so GIFs hosted there are never detected. Today they still animate
 * because the transform 403s on those off-zone sources and rawFallback swaps
 * in the original; on a zone configured to "resize from any origin" the
 * transform would succeed and freeze them.
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
