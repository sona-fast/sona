// The image a link preview gets: og:image (Meta.svelte) and the oEmbed provider
// (/api/oembed) must hand consumers the SAME URL and the SAME dimensions, so both
// import from here rather than each rolling their own. One function returns url +
// dimensions together because they only agree when derived from the same branch:
// an untransformed source must be advertised at its ORIGINAL size, not the capped
// one, or `url` and `width`/`height` describe different images.
//
// Deliberately unlike cdnImage() in $lib/img: no dev bypass. Social consumers
// fetch from the public edge, not from the dev server. No animated-source bypass
// either — considered and declined: the same-zone check below already covers the
// 403 case (off-zone GIFs 403 the transform anyway, per img.ts), and on-zone
// animated sources ride the transform successfully (see cdnImage's docblock).

import { isSameZoneImageHost } from '$lib/img';

export const OG_MAX_WIDTH = 1200;

export interface SocialImage {
	/** Absolute URL to advertise, transformed only when the edge can serve it. */
	url: string;
	/** The dimensions of THAT url — capped only when the transform applied. */
	width: number | null;
	height: number | null;
}

/** One axis, normalised: a stored 0 is as good as missing (and invalid to advertise). */
function axis(value: number | null | undefined): number | null {
	return value ? value : null;
}

/**
 * The dimensions of the TRANSFORMED image (`width=1200,fit=scale-down`), per axis
 * so a row with only one column set still describes the URL we advertise:
 *  - both known → the scaled pair, ratio preserved;
 *  - width only → the width the transform yields (capped), while the height it
 *    scaled to is unknowable without the original ratio, so it stays null;
 *  - height only → the stored height, and no width; scale-down caps the WIDTH, so
 *    the height only moves when the unknown original width was over the cap, and
 *    the real stored value beats the endpoint's placeholder either way.
 * No ratio is invented from a single axis on any path.
 */
function transformedDimensions(raw: { width: number | null; height: number | null }): {
	width: number | null;
	height: number | null;
} {
	if (raw.width === null || raw.width <= OG_MAX_WIDTH) return raw;
	if (raw.height === null) return { width: OG_MAX_WIDTH, height: null };
	return {
		width: OG_MAX_WIDTH,
		height: Math.round(raw.height * (OG_MAX_WIDTH / raw.width))
	};
}

/**
 * The image URL and matching dimensions to advertise for `src` on the page at
 * `pageUrl`. Transforms only what the edge can serve — relative sources, and
 * absolute ones on the page's own zone per isSameZoneImageHost (including the
 * fork's r2PublicUrl subdomain) — capped to OG_MAX_WIDTH. Every other host
 * (UploadThing, `*.r2.dev`, an R2 custom domain on a different zone, any non-CF
 * CDN) is advertised untouched at its original size instead: the transform 403s
 * off-zone sources (see $lib/img) and a JSON payload has no rawFallback to swap
 * the original back in. `storageProvider` defaults to uploadthing, so that is the
 * common case. Verified live 2026-08-12: transforming an off-zone source returns
 * 403 even on a zone whose image_resizing setting is "open".
 *
 * A root-relative `src` yields a double slash after `format=auto/`. That is
 * deliberate — verified live that Cloudflare resolves both forms identically
 * (favicon.svg: 200 either way; a non-image source: 415 either way), and the tests
 * below pin the current string, so "fixing" it would change og:image output on
 * every fork storing relative URLs for no gain.
 *
 * PRECONDITION: the transformed URL only resolves on a zone with Cloudflare Image
 * Transformations enabled. `scripts/setup.ts` enables it best-effort (optional), and
 * a fork served on `*.pages.dev` cannot enable it at all — on such a fork the URL
 * advertised here 404s and link previews show no image.
 */
export function socialImage(
	src: string,
	pageUrl: string,
	width?: number | null,
	height?: number | null
): SocialImage {
	const raw = { width: axis(width), height: axis(height) };

	// Shapes the transform cannot express, advertised unchanged: an empty/whitespace
	// src (a transform URL with no source), a protocol-relative one (`new URL()`
	// throws on it, so the off-zone check below would wrongly read it as same-zone —
	// cf. the same guard in $lib/server/ref-image.ts), and one that is already a
	// transform URL (Cloudflare rejects a nested /cdn-cgi/image/).
	const source = src.trim();
	if (!source || source.startsWith('//') || source.includes('/cdn-cgi/image/'))
		return { url: source, ...raw };

	let page: URL;
	try {
		page = new URL(pageUrl);
	} catch {
		return { url: source, ...raw };
	}

	let srcHost = '';
	try {
		srcHost = new URL(source).hostname;
	} catch {
		// Not an absolute URL — relative sources are same-zone by definition.
	}
	if (srcHost && !isSameZoneImageHost(srcHost, page.hostname)) return { url: source, ...raw };

	return {
		url: `${page.origin}/cdn-cgi/image/width=${OG_MAX_WIDTH},quality=85,fit=scale-down,format=auto/${source}`,
		...transformedDimensions(raw)
	};
}
