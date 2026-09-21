// Which font file the active theme should preload, resolved from the theme DATA.
//
// SERVER ONLY, and the .server suffix is the enforcement: this imports ./all.ts,
// which carries every palette of every theme. ./index.ts deliberately does not,
// because the admin settings and setup pages bundle it for the picker and would
// otherwise ship every hex value to the browser (see the comment there).
//
// Only the PRIMARY family's Latin slice is preloaded. That is the face the page
// title, the headings and the nav chrome render in, so it is the one whose late
// arrival the visitor watches swap. The body face and the other subsets stay on
// the normal @font-face path: preloading more would spend the same connection on
// bytes the first screen may never need.

import { ALL_THEMES } from './all.ts';
import { DEFAULT_THEME_ID } from './index.ts';
import { SUBSET_LATIN, type ThemeDefinition } from './types.ts';

/**
 * The first family named in a `font-family` list, unquoted. The list may quote
 * it with single quotes, or not at all. Exported for the unit test: every theme
 * today spells it with single quotes, so without that test a double-quoted or
 * unquoted list could start returning null and nothing would notice.
 */
export function firstFamily(list: string): string | null {
	const quoted = list.match(/^\s*'([^']+)'/) ?? list.match(/^\s*"([^"]+)"/);
	if (quoted) return quoted[1];
	const bare = list.split(',')[0].trim();
	return bare || null;
}

/** Whether a face's weight declaration covers the 600 the headings render at. */
function covers600(weight: number | string): boolean {
	if (typeof weight === 'number') return weight === 600;
	const [lo, hi] = weight.trim().split(/\s+/).map(Number);
	if (!Number.isFinite(lo)) return false;
	return Number.isFinite(hi) ? lo <= 600 && 600 <= hi : lo === 600;
}

/**
 * The Latin face file of a theme's primary family that covers the heading
 * weight, or null when the primary family has no self-hosted Latin face.
 */
function latinSrcOf(theme: ThemeDefinition): string | null {
	const family = firstFamily(theme.fonts?.primary ?? '');
	if (!family) return null;
	// Headings and the header logo render at 600, and the hero name at 700 (see
	// src/app.css). For a per-weight family that means the 600 cut, not whichever
	// file happens to be declared first; a variable face covers it with a range.
	const latin =
		theme.fonts?.faces?.filter((f) => f.family === family && f.unicodeRange === SUBSET_LATIN) ?? [];
	return latin.find((f) => covers600(f.weight))?.src ?? latin[0]?.src ?? null;
}

/**
 * The Latin woff2 of `themeId`'s primary family, or null when that family has no
 * self-hosted face of its own. A theme that declares no fonts at all (Pewter)
 * renders in the default theme's typography, so it preloads the default's face.
 * An unknown id is treated the same way, matching what the hook renders for it.
 */
export function primaryLatinFontSrc(themeId: string): string | null {
	const theme =
		ALL_THEMES.find((t) => t.id === themeId && t.fonts) ??
		ALL_THEMES.find((t) => t.id === DEFAULT_THEME_ID);
	return theme ? latinSrcOf(theme) : null;
}

/**
 * The `<link rel="preload">` tag for that file, or the empty string when there is
 * nothing to preload. `crossorigin` is not optional even though the file is
 * same-origin: fonts are fetched in CORS mode, and a preload without it is
 * fetched a second time rather than reused.
 */
export function fontPreloadTag(themeId: string): string {
	const src = primaryLatinFontSrc(themeId);
	if (!src) return '';
	return `<link rel="preload" as="font" type="font/woff2" crossorigin href="${src}" />`;
}

/**
 * The same preload as a `Link` response header value, or the empty string when
 * there is nothing to preload. Cloudflare turns `Link: rel=preload` headers into
 * Early Hints, so the browser can start the font before the HTML arrives.
 */
export function fontPreloadLinkHeader(themeId: string): string {
	const src = primaryLatinFontSrc(themeId);
	if (!src) return '';
	return `<${src}>; rel=preload; as=font; type=font/woff2; crossorigin`;
}
