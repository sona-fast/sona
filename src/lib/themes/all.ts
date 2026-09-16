// The theme DATA — full palettes, imported only by scripts/build-themes.ts and
// the tests. Keep it out of index.ts: index.ts is imported by the admin settings
// and setup pages, and re-exporting the palettes from there pulls every hex
// value of every theme into those client bundles for no runtime use (the browser
// reads the colours from generated.css, not from JS).
//
// ALL_THEMES order is the CSS source order, which is load-bearing: an alternate
// theme's light block carries two attribute selectors and wins on specificity,
// but the other three block shapes (:root, [data-theme='light'],
// [data-theme-id='x']) all tie, so among those a later block beats an earlier
// one (see the --link comments in aurora.theme.ts and terracotta.theme.ts). The
// default theme must come first — the generator throws otherwise.

import type { ThemeDefinition } from './types.ts';
import { defaultTheme } from './default.theme.ts';
import { auroraTheme } from './aurora.theme.ts';
import { terracottaTheme } from './terracotta.theme.ts';
import { petalTheme } from './petal.theme.ts';
import { pewterTheme } from './pewter.theme.ts';

export const ALL_THEMES: ThemeDefinition[] = [
	defaultTheme,
	auroraTheme,
	terracottaTheme,
	petalTheme,
	pewterTheme
];
