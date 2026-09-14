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
import { ALL_THEMES } from '../src/lib/themes/index.ts';
import { TOKEN_ORDER, cssName, cssValue, type ThemeDefinition } from '../src/lib/themes/types.ts';

export const OUTPUT_PATH = fileURLToPath(new URL('../src/lib/themes/generated.css', import.meta.url));

const HEADER = `/* GENERATED FILE — do not edit.
   Rendered from src/lib/themes/*.theme.ts by scripts/build-themes.ts.
   Edit the theme file and run \`npm run themes\`, then commit this file.

   Block order is source order, and source order decides ties: the theme blocks
   all have the same specificity, so a token an alternate theme does not declare
   falls through to :root / [data-theme='light'] — see types.ts. */
`;

/** One selector + its declarations, as a formatted CSS rule. '' is a blank line. */
function rule(selector: string, declarations: string[]): string {
	return `${selector} {\n${declarations.map((d) => (d === '' ? '' : `\t${d}`)).join('\n')}\n}\n`;
}

function tokenDeclarations(tokens: ThemeDefinition['dark']): string[] {
	const out: string[] = [];
	for (const [key] of TOKEN_ORDER) {
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

/** Selectors for a theme's two blocks. The first theme is the default one. */
function selectors(theme: ThemeDefinition, isDefault: boolean): { dark: string; light: string } {
	return isDefault
		? { dark: ':root', light: "[data-theme='light']" }
		: {
				dark: `[data-theme-id='${theme.id}']`,
				light: `[data-theme-id='${theme.id}'][data-theme='light']`
			};
}

export function renderThemesCss(themes: ThemeDefinition[]): string {
	const blocks = themes.flatMap((theme, i) => {
		const sel = selectors(theme, i === 0);
		return [
			`/* ${theme.label} */\n${block(theme, 'dark', sel.dark)}`,
			block(theme, 'light', sel.light)
		];
	});
	return `${HEADER}\n${blocks.join('\n')}`;
}

/** Exit code: 0 when the committed file matches, 1 when it is stale or missing. */
export function checkThemesCss(path: string, expected: string, log = console.error): number {
	let actual: string;
	try {
		actual = readFileSync(path, 'utf8');
	} catch {
		log(`✖ ${path} is missing. Run \`npm run themes\`.`);
		return 1;
	}
	if (actual === expected) return 0;
	log(`✖ ${path} is out of date with the theme data. Run \`npm run themes\` and commit the result.`);
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
