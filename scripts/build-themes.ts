#!/usr/bin/env tsx
/**
 * Sona build-themes — renders the theme data in src/lib/themes/*.theme.ts into
 * src/lib/themes/generated.css, which src/app.css imports.
 *
 *   npm run themes         # regenerate the CSS
 *   npm run themes:check   # exit 1 if the committed CSS is stale (CI)
 *
 * The palette lives in the theme files; this only lays it out. Emission order
 * is ALL_THEMES order, and within a block the TOKEN_ORDER from types.ts — both
 * are load-bearing, because theme blocks tie on specificity and the later one
 * wins.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { ALL_THEMES } from '../src/lib/themes/all.ts';
import { assertNoAliasCycles } from '../src/lib/themes/cascade.ts';
import { DEFAULT_THEME_ID } from '../src/lib/themes/index.ts';
import { TOKEN_CSS_NAMES, cssName, cssValue, type ThemeDefinition, type TokenKey } from '../src/lib/themes/types.ts';

export const OUTPUT_PATH = fileURLToPath(new URL('../src/lib/themes/generated.css', import.meta.url));

const HEADER = `/* GENERATED FILE — do not edit.
   Rendered from src/lib/themes/*.theme.ts by scripts/build-themes.ts.
   Edit the theme file and run \`npm run themes\`, then commit this file.

   Only one block shape wins on specificity: an alternate theme's light block,
   which carries two attribute selectors. The other three (:root,
   [data-theme='light'], [data-theme-id='x']) all tie, so among them the later
   block in this file wins — which is why an alternate theme's light block has to
   re-declare --link rather than inherit it from [data-theme='light']. A token no
   matching block declares falls through to :root — see types.ts. */
`;

/** One selector + its declarations, as a formatted CSS rule. '' is a blank line. */
function rule(selector: string, declarations: string[]): string {
	return `${selector} {\n${declarations.map((d) => (d === '' ? '' : `\t${d}`)).join('\n')}\n}\n`;
}

function tokenDeclarations(tokens: ThemeDefinition['dark']): string[] {
	const out: string[] = [];
	for (const key of Object.keys(TOKEN_CSS_NAMES) as TokenKey[]) {
		const value = tokens[key];
		// A token the block does not declare is left to the cascade on purpose.
		if (value === undefined) continue;
		out.push(`${cssName(key)}: ${cssValue(key, value)};`);
	}
	return out;
}

function block(theme: ThemeDefinition, mode: 'dark' | 'light', selector: string): string {
	const declarations = tokenDeclarations(theme[mode]);
	// Fonts ride the dark block: its selector matches in BOTH modes (the light
	// selector is the same one plus [data-theme='light']), so one declaration
	// serves the whole theme.
	if (mode === 'dark' && theme.fonts) {
		declarations.push('', `--font-primary: ${theme.fonts.primary};`, `--font-secondary: ${theme.fonts.secondary};`);
	}
	declarations.push('', `color-scheme: ${mode};`);
	return rule(selector, declarations);
}

/**
 * Selectors for a theme's two blocks. The default theme owns :root. Exported so
 * src/lib/theme-contrast.test.ts names blocks with the generator's own strings
 * rather than a copy that can drift from it.
 */
export function themeSelectors(theme: ThemeDefinition): { dark: string; light: string } {
	return theme.id === DEFAULT_THEME_ID
		? { dark: ':root', light: "[data-theme='light']" }
		: {
				dark: `[data-theme-id='${theme.id}']`,
				light: `[data-theme-id='${theme.id}'][data-theme='light']`
			};
}

const THEME_ID = /^[a-z][a-z0-9-]*$/;
// Letters, digits, spaces, commas, quotes, hyphens — enough for a CSS
// font-family list and nothing that could close the declaration. The letter and
// digit classes are Unicode, so a family named in Japanese, Greek or Cyrillic
// passes; only the punctuation is restricted.
const FONT_FAMILY = /^[\p{L}\p{N} ,'"-]+$/u;

// These three strings reach the CSS unescaped: the id lands inside an attribute
// selector, the label inside a comment, the font lists inside a declaration. A
// stray quote, brace, or comment terminator would emit CSS that means something
// other than the theme data says, so reject it the way cssValue rejects a value.
function validateTheme(theme: ThemeDefinition): void {
	if (!THEME_ID.test(theme.id)) {
		throw new Error(`theme id '${theme.id}' is not a slug (lowercase letter, then letters, digits, hyphens)`);
	}
	if (theme.label.includes('*' + '/')) {
		throw new Error(`theme '${theme.id}': label must not contain a comment terminator`);
	}
	for (const [slot, family] of Object.entries(theme.fonts ?? {})) {
		if (!FONT_FAMILY.test(family)) {
			throw new Error(`theme '${theme.id}': ${slot} font-family '${family}' has characters outside letters, digits, spaces, commas, quotes, and hyphens`);
		}
		// The character set allows quotes, so an odd count leaves one open and the
		// rest of the stylesheet lands inside a string literal.
		for (const quote of ["'", '"']) {
			if (family.split(quote).length % 2 === 0) {
				throw new Error(`theme '${theme.id}': ${slot} font-family '${family}' has an unbalanced ${quote} quote`);
			}
		}
	}
}

export function renderThemesCss(themes: ThemeDefinition[]): string {
	for (const theme of themes) validateTheme(theme);
	// Emission order is source order and the default theme is the fallback floor,
	// so it has to be emitted first (see the HEADER above).
	if (themes[0]?.id !== DEFAULT_THEME_ID) {
		throw new Error(`the first theme must be the default one ('${DEFAULT_THEME_ID}'), got '${themes[0]?.id}'`);
	}
	// Aliases are emitted as var() and resolved by the browser, so a loop between
	// two of them renders as valid CSS and drops both tokens at use time. Checked
	// here, over the same cascade chains the contrast test reads (cascade.ts),
	// after the default-first check that those chains depend on.
	assertNoAliasCycles(themes);
	const blocks = themes.flatMap((theme) => {
		const sel = themeSelectors(theme);
		return [
			`/* ${theme.label} */\n${block(theme, 'dark', sel.dark)}`,
			block(theme, 'light', sel.light)
		];
	});
	return `${HEADER}\n${blocks.join('\n')}`;
}

/** Exit code: 0 when the committed file matches, 1 when it is stale or missing. */
export function checkThemesCss(path: string, expected: string): number {
	let actual: string;
	try {
		actual = readFileSync(path, 'utf8');
	} catch {
		console.error(`✖ ${path} is missing. Run \`npm run themes\`.`);
		return 1;
	}
	if (actual === expected) return 0;
	console.error(`✖ ${path} is out of date with the theme data. Run \`npm run themes\` and commit the result.`);
	return 1;
}

function main(): number {
	const css = renderThemesCss(ALL_THEMES);
	if (argv.includes('--check')) return checkThemesCss(OUTPUT_PATH, css);
	writeFileSync(OUTPUT_PATH, css);
	console.log(`✔ wrote ${OUTPUT_PATH} (${ALL_THEMES.length} themes)`);
	return 0;
}

// Only run when invoked directly, so the unit tests can import the helpers.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
	exit(main());
}
