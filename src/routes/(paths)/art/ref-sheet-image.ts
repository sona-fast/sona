import { responsiveSrc, responsiveSrcset, responsiveSizes } from '$lib/img';
import type { ResponsiveImage } from '$lib/img';

// The ref sheet is /art's LCP element. It lives in the (paths) shell, whose
// .paths-page caps at 600px with 28px of .section padding either side — so the
// image slot is at most 544 CSS px, and 100vw - 56px below that. The ladder is
// sized for THAT box, not the gallery hero's ~810px column: 600w covers a 1x
// display, 1100w a 2x one, and 1600w is the headroom above.
const REF_SHEET: ResponsiveImage = {
	widths: [600, 1100, 1600],
	sizes: '(max-width: 600px) calc(100vw - 56px), 544px',
	// cdnImage's own default, stated rather than inherited so a change to that
	// default can't silently re-encode the LCP image.
	quality: 75,
	srcWidth: 1100
};

/** Default ref-sheet src: the 1100px CDN transform (raw original when animated). */
export function refSheetSrc(url: string): string {
	return responsiveSrc(url, REF_SHEET);
}

/** Responsive width variants, or undefined for an animated source. */
export function refSheetSrcset(url: string): string | undefined {
	return responsiveSrcset(url, REF_SHEET);
}

/** `sizes` for the ref-sheet srcset; omitted when animated (no srcset to size). */
export function refSheetSizes(url: string): string | undefined {
	return responsiveSizes(url, REF_SHEET);
}
