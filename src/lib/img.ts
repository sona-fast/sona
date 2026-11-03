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
 * True for UploadThing's image hosts (`ufs.sh` / `utfs.io`, incl. subdomains).
 * The one place that list lives, so the caller that special-cases UploadThing
 * (ref-image.ts's crossorigin branch) cannot drift from it.
 */
export function isUploadThingHost(host: string): boolean {
	return (
		host === 'ufs.sh' ||
		host === 'utfs.io' ||
		host.endsWith('.ufs.sh') ||
		host.endsWith('.utfs.io')
	);
}

/** Registrable domain, approximated as the last two labels of a hostname. */
function registrableDomain(host: string): string {
	return host.split('.').slice(-2).join('.');
}

/**
 * True when an image source hostname is on the same Cloudflare zone as the page
 * serving it, and may therefore ride a `/cdn-cgi/image/...` transform: the page
 * host itself, or a host whose registrable domain IS the page host (a fork's own
 * r2PublicUrl subdomain, `cdn.example.com` on `example.com`).
 *
 * An ALLOW-list, not a deny-list of known off-zone hosts: the transform 403s
 * every off-zone source, and a deny-list can only enumerate the ones we thought
 * of — an R2 custom domain on a different zone, or any non-CF CDN, would get a
 * transform URL that 403s. Unrecognised hosts fall to raw, which always works.
 *
 * Registrable domain is approximated as the last two labels, which is why the
 * comparison is against the page host itself rather than the page's own last two:
 * every fork domain is two labels, and under a multi-part TLD the sloppy version
 * would read two UNRELATED registrations (`example.co.uk`, `other.co.uk`) as one
 * zone. Here `cdn.example.co.uk` compares `co.uk` against `example.co.uk`, does
 * not match, and is served raw — the failing-safe side. Same for a page served on
 * a subdomain: siblings of `www.example.com` fall to raw rather than guess.
 */
export function isSameZoneImageHost(srcHost: string, pageHost: string): boolean {
	if (!srcHost || !pageHost) return false;
	if (srcHost === pageHost) return true;
	return registrableDomain(srcHost) === pageHost;
}

/**
 * Route an image URL through Cloudflare Image Transformations so grids
 * and thumbnails don't download multi-MB originals. In dev the CF edge
 * isn't available, so fall through to the raw URL.
 *
 * Link-preview images do NOT come through here: $lib/social-image has its own
 * transform (no dev bypass, no animated bypass) because social consumers fetch
 * from the public edge and a JSON payload has no rawFallback.
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
 * list view, the admin image list, and the VR/collections pickers all request
 * it.
 *
 * Sharing ONE width is what keeps this affordable: a transform URL is its own
 * cache key, so every surface asking for 200 reuses the variant the first one
 * generated. A surface that picks its own width spends a fresh Image
 * Transformation per image (the plan allows 5000 unique ones), which is why new
 * thumbnail call sites should use this rather than a hand-picked number.
 */
export const THUMB_WIDTH = 200;

/**
 * Artwork cards (gallery grid, home "recent", a collection) sit in a
 * `minmax(240px, 1fr)` grid with a 20px gap in the 1280px container (24px side
 * padding): exactly 293px wide once the viewport reaches 1280px, at most ~370px
 * between 769px and 1279px, and up to the full viewport on mobile (a collection
 * drops to one column below ~548px). `sizes` says 293px, 370px, and 100vw. The
 * top step is the exact slot, not a rounder 300px: Chromium at 1x takes the
 * smallest candidate at least as wide as `sizes`, so 300px × 1.34 = 402px sends
 * a 4:3 desktop card to 800 for a slot that needs 391px. The middle step ends
 * at 1279px for the same reason: at 1280px the slot is already 293px. Mobile
 * defaults to 100vw, so a one-column phone never upscales. A surface whose
 * phone grid is two columns passes `mobileColumns` 2 for 50vw, which still
 * covers the real slot (half the viewport minus padding and gap).
 *
 * The slot is a square drawn with `object-fit: cover`, so a landscape image is
 * painted at the slot height times its aspect ratio. Each slot width is scaled
 * by f = max(1, width / height), rounded up to two decimals; a portrait image
 * fills the width and needs no scaling. A very wide image can need more than
 * 800px on a 2x or 3x screen, and the ladder still stops at 800, which is what
 * every card requested before this ladder existed.
 *
 * Two steps. 800 is the width cards always requested, and it stays the `src`,
 * so a browser without srcset, and a card whose image has no stored
 * dimensions (null here: no srcset at all), reuse that variant. 400 is a NEW
 * transform for almost every image: only a few collection mosaic tiles
 * request 400 on image_url. It costs up to one extra Image Transformation per
 * displayed image per month on each fork. Don't add steps without counting the
 * transformations they cost.
 */
export function cardImage(
	width?: number | null,
	height?: number | null,
	mobileColumns: 1 | 2 = 1
): ResponsiveImage | null {
	if (!width || !height || width <= 0 || height <= 0) return null;
	// Integer hundredths, so 370 × 1.1 is exactly 407, not 407.00000000000006,
	// which the ceil would turn into a whole extra pixel.
	const f100 = Math.max(100, Math.ceil((width * 100) / height));
	const scale = (px: number) => Math.ceil((px * f100) / 100);
	const vw = mobileColumns === 2 ? '50vw' : '100vw';
	const mobile = f100 === 100 ? vw : `calc(${vw} * ${f100 / 100})`;
	return {
		widths: [400, 800],
		sizes: `(max-width: 768px) ${mobile}, (max-width: 1279px) ${scale(370)}px, ${scale(293)}px`,
		quality: 75,
		srcWidth: 800
	};
}

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
