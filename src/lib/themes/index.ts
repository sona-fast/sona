// Theme registry. Each entry is a palette family applied at SSR via a
// `data-theme-id` attribute on <html>; the dark/light *mode* is orthogonal to
// the theme. The palettes themselves are DATA — one file per theme in this
// directory — and src/lib/themes/generated.css is built from them by
// `scripts/build-themes.ts`. To change a colour: edit the theme file and run
// `npm run themes` (or `npm run prepare`), then commit the regenerated CSS;
// `npm run themes:check` fails CI if the committed CSS has drifted. To add a
// theme: add a `<id>.theme.ts` file and list it in ALL_THEMES below.
//
// ALL_THEMES order is the CSS source order, which is load-bearing: theme blocks
// tie on specificity, so a later block wins a tie against an earlier one (see
// the --link comments in aurora.theme.ts and terracotta.theme.ts).

import type { ThemeDefinition } from './types.ts';
import { defaultTheme } from './default.theme.ts';
import { auroraTheme } from './aurora.theme.ts';
import { terracottaTheme } from './terracotta.theme.ts';

export type { ThemeDefinition } from './types.ts';

export const ALL_THEMES: ThemeDefinition[] = [defaultTheme, auroraTheme, terracottaTheme];

export interface ThemeOption {
	id: string;
	label: string;
}

export const THEMES: ThemeOption[] = ALL_THEMES.map(({ id, label }) => ({ id, label }));

export const DEFAULT_THEME_ID = defaultTheme.id;

export function isValidThemeId(id: string): boolean {
	return THEMES.some((t) => t.id === id);
}
