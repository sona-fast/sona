import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderThemesCss, checkThemesCss, OUTPUT_PATH } from './build-themes.ts';
import { ALL_THEMES } from '../src/lib/themes/all.ts';
import type { ThemeDefinition, TokenKey } from '../src/lib/themes/types.ts';

// A two-token fixture rather than the real palettes: this asserts the LAYOUT
// (selectors, order, aliases, fonts, the inherit rule), and pinning it to the
// real themes would make every palette tweak a test edit.
const fixture: ThemeDefinition[] = [
	{
		id: 'default',
		label: 'Fixture default',
		dark: { background: '#111111', primary: '#FF8400', link: { ref: 'primary' } },
		light: { background: '#FFFFFF', primary: '#AA4400', link: '#883300' },
		fonts: { primary: "'A', monospace", secondary: "'B', sans-serif" }
	},
	{
		id: 'alt',
		label: 'Fixture alt',
		// No --link in the light set: it inherits, which is the case the generator
		// must NOT paper over.
		dark: { background: '#000011', primary: '#5555FF', sidebarBorder: 'rgba(255, 255, 255, 0.1)' },
		light: { background: '#EEEEFF' }
	}
];

describe('renderThemesCss', () => {
	const css = renderThemesCss(fixture);

	it('emits the default theme on :root and [data-theme=light], others on data-theme-id', () => {
		const selectors = [...css.matchAll(/^(\S.*) \{$/gm)].map((m) => m[1]);
		expect(selectors).toEqual([
			':root',
			"[data-theme='light']",
			"[data-theme-id='alt']",
			"[data-theme-id='alt'][data-theme='light']"
		]);
	});

	it('emits hex verbatim, aliases as var(), and rgba() as written', () => {
		expect(css).toContain('\t--background: #111111;');
		expect(css).toContain('\t--link: var(--primary);');
		expect(css).toContain('\t--sidebar-border: rgba(255, 255, 255, 0.1);');
	});

	it('emits only the tokens a block declares', () => {
		const altLight = css.match(/\[data-theme-id='alt'\]\[data-theme='light'\] \{([^}]*)\}/)?.[1] ?? '';
		expect(altLight).toContain('--background: #EEEEFF;');
		// Inherited, not re-declared: writing it here would add a declaration that
		// wins a source-order tie the real palettes depend on.
		expect(altLight).not.toContain('--link');
		expect(altLight).not.toContain('--primary');
	});

	it('sets color-scheme per mode and the fonts only in the dark block', () => {
		const root = css.match(/^:root \{([^}]*)\}/m)?.[1] ?? '';
		const light = css.match(/^\[data-theme='light'\] \{([^}]*)\}/m)?.[1] ?? '';
		expect(root).toContain('color-scheme: dark;');
		expect(light).toContain('color-scheme: light;');
		expect(root).toContain("--font-primary: 'A', monospace;");
		expect(root).toContain("--font-secondary: 'B', sans-serif;");
		expect(light).not.toContain('--font-');
	});

	it('rejects a value that is not a hex, an rgba() string, or an alias', () => {
		const bad: ThemeDefinition[] = [
			{ id: 'default', label: 'Bad', dark: { background: 'red' }, light: {} }
		];
		expect(() => renderThemesCss(bad)).toThrow(/not a 6-digit hex/);
	});

	it('rejects an alias to an Object.prototype member', () => {
		// `ref in TOKEN_CSS_NAMES` also finds inherited members, so 'toString' used
		// to pass the guard and emit `var(undefined)`. The cast is the point of the
		// test: the type forbids it, a hand-edited theme file does not.
		const bad: ThemeDefinition[] = [
			{
				id: 'default',
				label: 'Bad',
				dark: { background: { ref: 'toString' as unknown as TokenKey } },
				light: {}
			}
		];
		expect(() => renderThemesCss(bad)).toThrow(/alias to unknown token 'toString'/);
	});

	// An alias loop renders as valid CSS that the browser resolves to the
	// guaranteed-invalid value, so both tokens vanish at use time with nothing to
	// show for it. Caught at generation, over the same cascade the contrast test
	// reads.
	it('rejects aliases that point at each other', () => {
		const bad: ThemeDefinition[] = [
			{
				id: 'default',
				label: 'Cyclic',
				dark: { accent: { ref: 'accentForeground' }, accentForeground: { ref: 'accent' } },
				light: {}
			}
		];
		expect(() => renderThemesCss(bad)).toThrow(/alias cycle on default\/dark: accent → accentForeground → accent/);
	});

	// The id, the label and the font lists are the three theme strings that reach
	// the CSS unescaped (attribute selector, comment, declaration), so each gets
	// the same treatment a bad colour value gets: a build failure.
	it('rejects a theme id that is not a slug', () => {
		const bad: ThemeDefinition[] = [
			{ id: "x'] , [data-theme-id='default", label: 'Bad', dark: {}, light: {} }
		];
		expect(() => renderThemesCss(bad)).toThrow(/is not a slug/);
	});

	it('rejects a label that closes the comment it is emitted into', () => {
		const bad: ThemeDefinition[] = [
			{ id: 'default', label: 'Bad *' + '/ :root { --background: #000000; } /*', dark: {}, light: {} }
		];
		expect(() => renderThemesCss(bad)).toThrow(/comment terminator/);
	});

	it('rejects a font-family outside the safe character set', () => {
		const bad: ThemeDefinition[] = [
			{
				id: 'default',
				label: 'Bad',
				dark: {},
				light: {},
				fonts: { primary: 'X; --background: #000000', secondary: "'B', sans-serif" }
			}
		];
		expect(() => renderThemesCss(bad)).toThrow(/font-family/);
	});

	it('rejects a font-family with an unbalanced quote', () => {
		const bad: ThemeDefinition[] = [
			{
				id: 'default',
				label: 'Bad',
				dark: {},
				light: {},
				fonts: { primary: "'Chakra Petch, sans-serif", secondary: "'B', sans-serif" }
			}
		];
		expect(() => renderThemesCss(bad)).toThrow(/unbalanced ' quote/);
	});

	// The scan tracks which quote opened the string, so the other one inside it is
	// just a character: a per-quote count rejected this well-formed family.
	it('accepts an apostrophe inside a double-quoted family name', () => {
		const ok: ThemeDefinition[] = [
			{
				id: 'default',
				label: 'Apostrophe',
				dark: { background: '#111111' },
				light: {},
				fonts: { primary: '"Sparky\'s Font", sans-serif', secondary: "'B', sans-serif" }
			}
		];
		expect(renderThemesCss(ok)).toContain('--font-primary: "Sparky\'s Font", sans-serif;');
	});

	it('accepts a family name written in a non-Latin script', () => {
		const ok: ThemeDefinition[] = [
			{
				id: 'default',
				label: 'CJK',
				dark: { background: '#111111' },
				light: {},
				fonts: { primary: "'ヒラギノ角ゴシック', sans-serif", secondary: "'B', sans-serif" }
			}
		];
		expect(renderThemesCss(ok)).toContain("--font-primary: 'ヒラギノ角ゴシック', sans-serif;");
	});

	it('rejects a theme list whose first entry is not the default theme', () => {
		const bad: ThemeDefinition[] = [{ id: 'alt', label: 'Alt', dark: {}, light: {} }];
		expect(() => renderThemesCss(bad)).toThrow(/first theme must be the default one/);
	});

	it('rejects two themes that share an id', () => {
		// Both would emit on [data-theme-id='alt'], so the later block wins and the
		// earlier theme's palette is unreachable.
		const bad: ThemeDefinition[] = [
			...fixture,
			{ id: 'alt', label: 'Fixture alt again', dark: {}, light: {} }
		];
		expect(() => renderThemesCss(bad)).toThrow(/duplicate theme id 'alt'/);
	});

	it('rejects an rgba() channel above 255', () => {
		const bad: ThemeDefinition[] = [
			{ id: 'default', label: 'Bad', dark: { sidebarBorder: 'rgba(999, 0, 0, 0.5)' }, light: {} }
		];
		expect(() => renderThemesCss(bad)).toThrow(/channels in 0-255/);
	});

	// `007` is a padded 7, which CSS accepts — the channel bound is on the value,
	// not on the digit count.
	it('accepts an rgba() channel written with leading zeros', () => {
		const ok: ThemeDefinition[] = [
			{ id: 'default', label: 'Padded', dark: { sidebarBorder: 'rgba(007, 12, 12, 0.5)' }, light: {} }
		];
		expect(renderThemesCss(ok)).toContain('--sidebar-border: rgba(007, 12, 12, 0.5);');
	});
});

// Catches a palette edit committed without `npm run themes`. In CI this
// particular assert is redundant — `npm ci` runs `prepare`, which regenerates
// the file before vitest ever reads it, and the CI job's `git diff` step is what
// actually fails on a stale commit. It still earns its place locally and under a
// bare `npm test` with no install in front of it.
describe('the committed generated.css', () => {
	it('matches what the theme data renders', () => {
		expect(readFileSync(OUTPUT_PATH, 'utf8')).toBe(renderThemesCss(ALL_THEMES));
	});
});

// src/app.css pulls the generated tokens in with an @import. CSS drops an
// @import that follows any rule other than @charset, @layer, or another @import,
// so a rule sneaking in above this line would ship a page with no colour tokens
// at all — and nothing else in the suite would notice.
describe('the app.css @import of the generated CSS', () => {
	const appCss = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8');
	const IMPORT_LINE = "@import './lib/themes/generated.css';";

	it('imports the generated stylesheet', () => {
		expect(appCss).toContain(IMPORT_LINE);
	});

	it('has nothing but @charset, other @imports, comments and whitespace above it', () => {
		// Eats the things that ARE allowed above it, from the top down: whitespace,
		// comments, and @charset/@import statements (quote-aware, because a Google
		// Fonts URL carries semicolons inside its quotes). Whatever is left is a
		// rule that would make the browser drop the import.
		const allowed = [
			/^\s+/,
			/^\/\*[\s\S]*?\*\//,
			/^@(?:charset|import)\b(?:[^;'"]|'[^']*'|"[^"]*")*;/
		];
		let rest = appCss.slice(0, appCss.indexOf(IMPORT_LINE));
		for (let eaten = true; eaten; ) {
			eaten = false;
			for (const re of allowed) {
				const match = rest.match(re)?.[0];
				if (match) {
					rest = rest.slice(match.length);
					eaten = true;
				}
			}
		}
		expect(rest, `unexpected CSS above the generated.css @import: ${rest.slice(0, 120)}`).toBe('');
	});
});

describe('checkThemesCss', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'sona-themes-'));
	const file = path.join(dir, 'generated.css');
	const expected = renderThemesCss(fixture);
	// Silences the failure message this prints; the spy is restored per test.
	const silence = () => vi.spyOn(console, 'error').mockImplementation(() => {});
	afterEach(() => vi.restoreAllMocks());

	it('passes when the committed file matches', () => {
		writeFileSync(file, expected);
		expect(checkThemesCss(file, expected)).toBe(0);
	});

	it('detects drift', () => {
		silence();
		writeFileSync(file, expected.replace('#111111', '#222222'));
		expect(checkThemesCss(file, expected)).toBe(1);
	});

	it('detects a missing file', () => {
		silence();
		expect(checkThemesCss(path.join(dir, 'nope.css'), expected)).toBe(1);
	});
});

// The tests above import the helpers, which leaves the direct-invocation guard
// at the bottom of the script untested — and a guard that skips main() fails
// silently: `npm run themes` writes nothing and `themes:check` keeps passing on
// stale CSS. So run the script the way npm does, as a subprocess. Two spawns,
// because tsx startup is the expensive part: one write into a temp file (which
// also proves the committed CSS is what the theme data renders), then --check
// against that file after staling it.
describe('running the script directly', () => {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const dir = mkdtempSync(path.join(tmpdir(), 'sona-themes-cli-'));
	const file = path.join(dir, 'generated.css');
	const run = (args: string[]) =>
		spawnSync(path.join(root, 'node_modules/.bin/tsx'), ['scripts/build-themes.ts', ...args], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, SONA_THEMES_OUTPUT: file }
		});

	const wrote = run([]);
	const written = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
	// Stale it only if the write happened; otherwise --check would report a
	// missing file and mask which of the two steps broke.
	if (written !== undefined) writeFileSync(file, `${written}\n/* stale */\n`);
	const stale = run(['--check']);

	it('runs main() and writes the themes', () => {
		expect(wrote.stderr).toBe('');
		expect(wrote.status).toBe(0);
		expect(wrote.stdout).toMatch(/wrote .* \(\d+ themes\)/);
		expect(wrote.stdout).toContain(`(${ALL_THEMES.length} themes)`);
		expect(written).toBe(readFileSync(OUTPUT_PATH, 'utf8'));
	});

	it('exits 1 from --check when the file is stale', () => {
		expect(stale.status).toBe(1);
		expect(stale.stderr).toMatch(/out of date with the theme data/);
	});
});
