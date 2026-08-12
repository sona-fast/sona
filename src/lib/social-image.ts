// The image a link preview gets: og:image (Meta.svelte) and the oEmbed provider
// (/api/oembed) must hand consumers the SAME URL and the SAME dimensions, so both
// import from here rather than each rolling their own. One function returns url +
// dimensions together because they only agree when derived from the same branch:
// an untransformed source must be advertised at its ORIGINAL size, not the capped
// one, or `url` and `width`/`height` describe different images.
//
// Deliberately unlike cdnImage() in $lib/img: no dev bypass. Social consumers
// fetch from the public edge, not from the dev server. No animated-source bypass
// either — considered and declined: the off-zone bypass below already covers the
// 403 case (off-zone GIFs 403 the transform anyway, per img.ts), and on-zone
// animated sources ride the transform successfully (see cdnImage's docblock).

import { isOffZoneImageHost } from '$lib/img';

export const OG_MAX_WIDTH = 1200;

export interface SocialImage {
	/** Absolute URL to advertise, transformed only when the edge can serve it. */
	url: string;
	/** The dimensions of THAT url — capped only when the transform applied. */
	width: number | null;
	height: number | null;
}

/** Raw dimensions, normalised: a missing side means we advertise neither. */
function rawDimensions(
	width: number | null | undefined,
	height: number | null | undefined
): { width: number | null; height: number | null } {
	if (!width || !height) return { width: null, height: null };
	return { width, height };
}

/**
 * The image URL and matching dimensions to advertise for `src` on the page at
 * `pageUrl`. Transforms by default — relative sources and absolute ones on the
 * fork's own zone (including its r2PublicUrl subdomain) — capped to OG_MAX_WIDTH.
 * A source on a KNOWN off-zone host (UploadThing, `*.r2.dev`) is advertised
 * untouched at its original size instead: the transform 403s those (see
 * $lib/img) and a JSON payload has no rawFallback to swap the original back in.
 * `storageProvider` defaults to uploadthing, so that is the common case. Verified
 * live 2026-08-12: transforming an off-zone source returns 403 even on a zone whose
 * image_resizing setting is "open".
 *
 * A root-relative `src` yields a double slash after `format=auto/`. That is
 * deliberate — verified live that Cloudflare resolves both forms identically
 * (favicon.svg: 200 either way; a non-image source: 415 either way), and the tests
 * below pin the current string, so "fixing" it would change og:image output on
 * every fork storing relative URLs for no gain.
 */
export function socialImage(
	src: string,
	pageUrl: string,
	width?: number | null,
	height?: number | null
): SocialImage {
	const raw = rawDimensions(width, height);

	let page: URL;
	try {
		page = new URL(pageUrl);
	} catch {
		return { url: src, ...raw };
	}

	let srcHost = '';
	try {
		srcHost = new URL(src).hostname;
	} catch {
		// Not an absolute URL — relative sources are same-zone by definition.
	}
	if (srcHost && isOffZoneImageHost(srcHost)) return { url: src, ...raw };

	const capped =
		raw.width && raw.height && raw.width > OG_MAX_WIDTH
			? {
					width: OG_MAX_WIDTH,
					height: Math.round(raw.height * (OG_MAX_WIDTH / raw.width))
				}
			: raw;

	return {
		url: `${page.origin}/cdn-cgi/image/width=${OG_MAX_WIDTH},quality=85,fit=scale-down,format=auto/${src}`,
		...capped
	};
}
