import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderThemesCss, checkThemesCss } from './build-themes.ts';
import type { ThemeDefinition } from '../src/lib/themes/types.ts';

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
});

describe('checkThemesCss', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'sona-themes-'));
	const file = path.join(dir, 'generated.css');
	const expected = renderThemesCss(fixture);
	const silent = () => {};

	it('passes when the committed file matches', () => {
		writeFileSync(file, expected);
		expect(checkThemesCss(file, expected, silent)).toBe(0);
	});

	it('detects drift', () => {
		writeFileSync(file, expected.replace('#111111', '#222222'));
		expect(checkThemesCss(file, expected, silent)).toBe(1);
	});

	it('detects a missing file', () => {
		expect(checkThemesCss(path.join(dir, 'nope.css'), expected, silent)).toBe(1);
	});
});
