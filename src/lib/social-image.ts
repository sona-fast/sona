// The image a link preview gets: og:image (Meta.svelte) and the oEmbed provider
// (/api/oembed) must hand consumers the SAME transformed URL and the SAME
// dimensions, so both import from here rather than each rolling their own.
//
// Deliberately unlike cdnImage() in $lib/img: no dev bypass and no animated-source
// bypass. Social consumers fetch from the public edge, not from the dev server.

export const OG_MAX_WIDTH = 1200;

/** The CDN-capped, absolute URL to advertise for `src` on the page at `pageUrl`. */
export function socialImageUrl(src: string, pageUrl: string): string {
	try {
		const origin = new URL(pageUrl).origin;
		return `${origin}/cdn-cgi/image/width=${OG_MAX_WIDTH},quality=85,fit=scale-down,format=auto/${src}`;
	} catch {
		return src;
	}
}

/** The dimensions of that capped image, aspect ratio preserved. */
export function socialImageDimensions(
	width: number | null | undefined,
	height: number | null | undefined
): { width: number | null; height: number | null } {
	if (!width || !height) return { width: null, height: null };
	if (width > OG_MAX_WIDTH) {
		return { width: OG_MAX_WIDTH, height: Math.round(height * (OG_MAX_WIDTH / width)) };
	}
	return { width, height };
}
