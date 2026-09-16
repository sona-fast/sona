// Theme registry — the id/label list the admin settings and setup pages render,
// and nothing else. Each entry is a palette family applied at SSR via a
// `data-theme-id` attribute on <html>; the dark/light *mode* is orthogonal to
// the theme.
//
// The palettes themselves are DATA — one file per theme in this directory,
// listed in ./all.ts — and src/lib/themes/generated.css is built from them by
// `scripts/build-themes.ts`. This file deliberately does NOT import them, so the
// client bundles that show the theme picker carry the two strings per theme they
// display rather than every palette. src/lib/themes/registry.test.ts asserts the
// two lists stay in step.
//
// To change a colour: edit the theme file and run `npm run themes` (or
// `npm run prepare`), then commit the regenerated CSS; CI fails on a stale
// commit. To add a theme: add a `<id>.theme.ts` file, list it in ./all.ts, and
// add its id/label here.

export interface ThemeOption {
	id: string;
	label: string;
}

export const THEMES: ThemeOption[] = [
	{ id: 'default', label: 'Ember — warm orange (default)' },
	{ id: 'aurora', label: 'Aurora — cool violet' },
	{ id: 'terracotta', label: 'Terracotta — warm clay' },
	{ id: 'petal', label: 'Petal — soft pink' },
	{ id: 'pewter', label: 'Pewter — quiet slate' }
];

export const DEFAULT_THEME_ID = 'default';

export function isValidThemeId(id: string): boolean {
	return THEMES.some((t) => t.id === id);
}
