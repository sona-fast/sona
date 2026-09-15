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
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { ALL_THEMES } from '../src/lib/themes/all.ts';
import { assertNoAliasCycles } from '../src/lib/themes/cascade.ts';
import { DEFAULT_THEME_ID } from '../src/lib/themes/index.ts';
import { TOKEN_CSS_NAMES, cssName, cssValue, type FontFace, type ThemeDefinition, type TokenKey } from '../src/lib/themes/types.ts';

export const OUTPUT_PATH = fileURLToPath(new URL('../src/lib/themes/generated.css', import.meta.url));

/** Where a face's `src` path resolves on disk: '/fonts/x.woff2' → static/fonts/x.woff2. */
const STATIC_DIR = fileURLToPath(new URL('../static/', import.meta.url));

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

const FONT_HEADER = `/* Self-hosted @font-face blocks (SONA-181). Top-level on purpose: @font-face
   cannot live inside a selector, so every theme's faces are declared here and
   the browser fetches a file only when an element actually renders in that
   family — which only happens under the theme whose block names it in
   --font-primary/--font-secondary. Files come from static/fonts/, fetched by
   \`node scripts/fetch-fonts.mjs\`. */
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
	// Only the two family lists — `faces` is an array and is validated separately
	// by validateFace. A slot the caller left unset is skipped.
	for (const slot of ['primary', 'secondary'] as const) {
		const family = theme.fonts?.[slot];
		if (family === undefined) continue;
		if (!FONT_FAMILY.test(family)) {
			throw new Error(`theme '${theme.id}': ${slot} font-family '${family}' has characters outside letters, digits, spaces, commas, quotes, and hyphens`);
		}
		// The character set allows both quote characters, so an unterminated string
		// leaves the rest of the stylesheet inside a literal. One scan, tracking
		// which quote opened the current string and ignoring the other while it is
		// open — counting each quote separately would reject the legitimate
		// `"Sparky's Font", sans-serif`. The same scan splits the list on the
		// commas that are outside a quoted name, so `"Foo, Bar", serif` stays one
		// name plus a fallback.
		let open: "'" | '"' | undefined;
		const entries: string[] = [];
		let entry = '';
		for (const char of family) {
			if (open === undefined) {
				if (char === "'" || char === '"') open = char;
				else if (char === ',') {
					entries.push(entry);
					entry = '';
					continue;
				}
			} else if (char === open) {
				open = undefined;
			}
			entry += char;
		}
		entries.push(entry);
		if (open !== undefined) {
			throw new Error(`theme '${theme.id}': ${slot} font-family '${family}' has an unbalanced ${open} quote`);
		}
		// An empty entry — a blank value, a lone comma, `Arial,,sans-serif` — emits
		// a declaration the browser drops, so reject it here instead.
		if (entries.some((name) => name.trim() === '')) {
			throw new Error(`theme '${theme.id}': ${slot} font-family '${family}' has an empty family name`);
		}
	}
}

// A face's family name and src reach the CSS unescaped, same as the font-family
// lists above. The family goes inside a quoted string and the src inside url(),
// so anything that could close either one is rejected rather than emitted.
const FACE_SRC = /^\/fonts\/[A-Za-z0-9._-]+\.woff2$/;
const FACE_WEIGHT = /^\d{3}( \d{3})?$/;

/**
 * One theme's `@font-face` blocks. They are emitted at the TOP of the file and
 * outside every selector, because @font-face is a top-level at-rule: nesting it
 * under [data-theme-id='terracotta'] would make the browser drop it. That is not
 * a leak — a browser downloads a font file only when an element actually renders
 * in that family, and only the theme's own block names these families in
 * --font-primary/--font-secondary. So the rules are always parsed and the bytes
 * are only fetched under the theme that uses them.
 */
function fontFaceRules(theme: ThemeDefinition): string[] {
	return (theme.fonts?.faces ?? []).map((face) => {
		validateFace(theme.id, face);
		const declarations = [
			`font-family: '${face.family}';`,
			`font-style: ${face.style ?? 'normal'};`,
			`font-weight: ${face.weight};`,
			'font-display: swap;',
			`src: url('${face.src}') format('woff2');`
		];
		if (face.unicodeRange) declarations.push(`unicode-range: ${face.unicodeRange};`);
		return rule('@font-face', declarations);
	});
}

// A src that does not resolve to a real, non-empty file renders as a perfectly
// valid @font-face the browser silently falls back from, so the page just wears
// the wrong typeface. Checked at generation time, where it is a build failure.
function validateFace(id: string, face: FontFace): void {
	if (!FONT_FAMILY.test(face.family)) {
		throw new Error(`theme '${id}': font face family '${face.family}' has characters outside letters, digits, spaces, commas, quotes, and hyphens`);
	}
	if (face.family.includes("'")) {
		throw new Error(`theme '${id}': font face family '${face.family}' must not contain a quote`);
	}
	if (!FACE_WEIGHT.test(String(face.weight))) {
		throw new Error(`theme '${id}': font face weight '${face.weight}' is not a 3-digit weight or a 'min max' range`);
	}
	if (face.style !== undefined && !/^(normal|italic|oblique)$/.test(face.style)) {
		throw new Error(`theme '${id}': font face style '${face.style}' is not normal, italic or oblique`);
	}
	if (!FACE_SRC.test(face.src)) {
		throw new Error(`theme '${id}': font face src '${face.src}' must be a /fonts/*.woff2 path`);
	}
	if (face.unicodeRange !== undefined && !/^U\+[0-9A-Fa-f?]+(-[0-9A-Fa-f]+)?(,\s*U\+[0-9A-Fa-f?]+(-[0-9A-Fa-f]+)?)*$/.test(face.unicodeRange)) {
		throw new Error(`theme '${id}': font face unicode-range '${face.unicodeRange}' is not a comma-separated list of U+ ranges`);
	}
	const onDisk = STATIC_DIR + face.src.slice(1);
	if (!existsSync(onDisk) || statSync(onDisk).size === 0) {
		throw new Error(`theme '${id}': font face src '${face.src}' has no file at ${onDisk} — run \`node scripts/fetch-fonts.mjs\``);
	}
}

export function renderThemesCss(themes: ThemeDefinition[]): string {
	for (const theme of themes) validateTheme(theme);
	// Emission order is source order and the default theme is the fallback floor,
	// so it has to be emitted first (see the HEADER above).
	if (themes[0]?.id !== DEFAULT_THEME_ID) {
		throw new Error(`the first theme must be the default one ('${DEFAULT_THEME_ID}'), got '${themes[0]?.id}'`);
	}
	// Two themes sharing an id emit two blocks on the same selector: the later one
	// silently wins in the browser, and the picker gets two entries that cannot be
	// told apart.
	const seen = new Set<string>();
	for (const theme of themes) {
		if (seen.has(theme.id)) throw new Error(`duplicate theme id '${theme.id}'`);
		seen.add(theme.id);
	}
	// Aliases are emitted as var() and resolved by the browser, so a loop between
	// two of them renders as valid CSS and drops both tokens at use time. Checked
	// here, over the same cascade chains the contrast test reads (cascade.ts),
	// after the default-first check that those chains depend on.
	assertNoAliasCycles(themes);
	const faces = themes.flatMap(fontFaceRules);
	const blocks = themes.flatMap((theme) => {
		const sel = themeSelectors(theme);
		return [
			`/* ${theme.label} */\n${block(theme, 'dark', sel.dark)}`,
			block(theme, 'light', sel.light)
		];
	});
	const fontSection = faces.length === 0 ? '' : `${FONT_HEADER}\n${faces.join('\n')}\n`;
	return `${HEADER}\n${fontSection}${blocks.join('\n')}`;
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
	// Unset in normal use. build-themes.test.ts points it at a temp file so it can
	// run this script as a subprocess — the only way to exercise the guard below —
	// without touching the committed CSS.
	const output = env.SONA_THEMES_OUTPUT || OUTPUT_PATH;
	if (argv.includes('--check')) return checkThemesCss(output, css);
	writeFileSync(output, css);
	console.log(`✔ wrote ${output} (${ALL_THEMES.length} themes)`);
	return 0;
}

// Only run when invoked directly, so the unit tests can import the helpers.
// Compared as realpaths: a symlinked checkout (or --preserve-symlinks-main)
// makes the two spellings differ, and the string compare would then skip main()
// silently — `npm run themes` would write nothing and `themes:check` would keep
// passing on stale CSS.
if (argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv[1])) {
	exit(main());
}
