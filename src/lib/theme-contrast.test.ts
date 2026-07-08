import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEMES } from './themes';

// Guards WCAG AA contrast for the terracotta theme: the terracotta accent is
// used as small-text foreground on the page background and on cards, and as
// the button background under --primary-foreground text. A future accent
// tweak that drops any of the asserted pairings below threshold fails here.
//
// Scope: the full terracotta pairings, both variants, plus the destructive
// button (fill vs --destructive-foreground) for EVERY theme × mode (#76). The
// remaining Ember/Aurora pairings predate the AA work and are not asserted.

const css = readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf8');

function blockToken(selector: string, name: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// Anchored to a line start so a plain selector (e.g. [data-theme='light'])
	// can't match the tail of a compound one ([data-theme-id='aurora'][data-theme='light']).
	const block = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
	if (!block) throw new Error(`${selector} block not found in app.css`);
	const value = block.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})\\s*;`))?.[1];
	if (!value) throw new Error(`--${name} not found as a 6-digit hex in the ${selector} block`);
	return value;
}

function luminance(hex: string): number {
	const n = parseInt(hex.slice(1), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

function comps(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: number[]): string {
	const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
	return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

// color-mix(in srgb, <hex> pct%, black|white) for opaque operands: interpolate the
// gamma-encoded channels toward 0 (black) or 255 (white).
function mixSrgb(hex: string, pct: number, toward: 'black' | 'white'): string {
	const p = pct / 100;
	const end = toward === 'black' ? 0 : 255;
	return toHex(comps(hex).map((v) => v * p + end * (1 - p)));
}

// Pulls the color-mix percentage + endpoint out of the hover rule's fill. Throws
// if the rule is missing or isn't a srgb color-mix (e.g. an opacity-dim hover),
// so #103 can't silently regress.
function hoverMix(selector: string): { pct: number; toward: 'black' | 'white' } {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const rule = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
	if (!rule) throw new Error(`${selector} rule not found in app.css`);
	const m = rule.match(
		/background-color:\s*color-mix\(in srgb,\s*var\(--[\w-]+\)\s*(\d+)%,\s*(black|white)\)/
	);
	if (!m) throw new Error(`${selector} has no srgb color-mix hover fill (opacity-dim hover reintroduced?)`);
	return { pct: Number(m[1]), toward: m[2] as 'black' | 'white' };
}

describe('destructive button WCAG AA contrast, every theme × mode', () => {
	// The default theme lives on :root / [data-theme='light']; alternate themes
	// on [data-theme-id='<id>'] and its [data-theme='light'] variant.
	const blocks = THEMES.flatMap(({ id }) =>
		id === 'default'
			? [
					{ name: 'default dark', sel: ':root' },
					{ name: 'default light', sel: "[data-theme='light']" }
				]
			: [
					{ name: `${id} dark`, sel: `[data-theme-id='${id}']` },
					{ name: `${id} light`, sel: `[data-theme-id='${id}'][data-theme='light']` }
				]
	);

	for (const { name, sel } of blocks) {
		it(`${name}: destructive-foreground text on destructive buttons meets 4.5:1`, () => {
			const destructive = blockToken(sel, 'destructive');
			const destructiveForeground = blockToken(sel, 'destructive-foreground');
			expect(contrast(destructiveForeground, destructive)).toBeGreaterThanOrEqual(4.5);
		});
	}

	it('.btn-destructive colors its text with var(--destructive-foreground)', () => {
		// The token assertions above are only meaningful if the rule actually
		// uses the token; a refactor back to var(--foreground) reintroduces #76.
		// No fallback either: every theme block must define the token itself.
		const rule = css.match(/^\.btn-destructive\s*\{([^}]*)\}/m)?.[1];
		if (!rule) throw new Error('.btn-destructive rule not found in app.css');
		expect(rule).toMatch(/color:\s*var\(--destructive-foreground\)\s*;/);
	});
});

describe('terracotta light theme WCAG AA contrast', () => {
	const sel = "[data-theme-id='terracotta'][data-theme='light']";
	const primary = blockToken(sel, 'primary');
	const primaryForeground = blockToken(sel, 'primary-foreground');
	const background = blockToken(sel, 'background');
	const card = blockToken(sel, 'card');
	const ring = blockToken(sel, 'ring');
	const destructive = blockToken(sel, 'destructive');

	it('destructive text on the page background meets 4.5:1', () => {
		expect(contrast(destructive, background)).toBeGreaterThanOrEqual(4.5);
	});

	it('destructive text on cards meets 4.5:1', () => {
		expect(contrast(destructive, card)).toBeGreaterThanOrEqual(4.5);
	});

	it('primary text on the page background meets 4.5:1', () => {
		expect(contrast(primary, background)).toBeGreaterThanOrEqual(4.5);
	});

	it('primary text on cards meets 4.5:1', () => {
		expect(contrast(primary, card)).toBeGreaterThanOrEqual(4.5);
	});

	it('primary-foreground text on primary buttons meets 4.5:1', () => {
		expect(contrast(primaryForeground, primary)).toBeGreaterThanOrEqual(4.5);
	});

	it('focus ring against the page background meets 3:1 (non-text UI)', () => {
		expect(contrast(ring, background)).toBeGreaterThanOrEqual(3);
	});
});

describe('terracotta dark theme WCAG AA contrast', () => {
	const sel = "[data-theme-id='terracotta']";
	const primary = blockToken(sel, 'primary');
	const primaryForeground = blockToken(sel, 'primary-foreground');
	const background = blockToken(sel, 'background');
	const card = blockToken(sel, 'card');
	const ring = blockToken(sel, 'ring');
	const destructive = blockToken(sel, 'destructive');

	it('destructive text on the page background meets 4.5:1', () => {
		expect(contrast(destructive, background)).toBeGreaterThanOrEqual(4.5);
	});

	it('destructive text on cards meets 4.5:1', () => {
		expect(contrast(destructive, card)).toBeGreaterThanOrEqual(4.5);
	});

	it('primary text on the page background meets 4.5:1', () => {
		expect(contrast(primary, background)).toBeGreaterThanOrEqual(4.5);
	});

	it('primary text on cards meets 4.5:1', () => {
		expect(contrast(primary, card)).toBeGreaterThanOrEqual(4.5);
	});

	it('primary-foreground text on primary buttons meets 4.5:1', () => {
		expect(contrast(primaryForeground, primary)).toBeGreaterThanOrEqual(4.5);
	});

	it('focus ring against the page background meets 3:1 (non-text UI)', () => {
		expect(contrast(ring, background)).toBeGreaterThanOrEqual(3);
	});
});

// The .btn hover shifts only the fill (color-mix), never the label opacity: a
// blanket `opacity` hover composited the label over the page and dropped its
// contrast below AA in several themes (#103). Here we parse the actual color-mix
// out of app.css, apply it to each theme's fill token, and assert the (unchanged)
// label token still clears 4.5:1. Fails if the hover reverts to an opacity dim
// (no color-mix to parse) or if someone picks an AA-failing mix.
describe('.btn hover-state WCAG AA contrast, every theme × variant (#103)', () => {
	// name → { fill token, label token }. Selector for the fill depends on mode.
	const variants = [
		{ name: 'primary', fill: 'primary', label: 'primary-foreground' },
		{ name: 'secondary', fill: 'secondary', label: 'secondary-foreground' },
		{ name: 'outline', fill: 'background', label: 'foreground' },
		{ name: 'destructive', fill: 'destructive', label: 'destructive-foreground' }
	];

	// Dark modes use the base `.btn-*:hover` rule; light modes the
	// `[data-theme='light'] .btn-*:hover` override (every light theme carries that
	// attribute, so one override branch serves them all).
	const themeBlocks = THEMES.flatMap(({ id }) =>
		id === 'default'
			? [
					{ name: 'default dark', block: ':root', mode: 'dark' as const },
					{ name: 'default light', block: "[data-theme='light']", mode: 'light' as const }
				]
			: [
					{ name: `${id} dark`, block: `[data-theme-id='${id}']`, mode: 'dark' as const },
					{
						name: `${id} light`,
						block: `[data-theme-id='${id}'][data-theme='light']`,
						mode: 'light' as const
					}
				]
	);

	for (const { name, block, mode } of themeBlocks) {
		for (const v of variants) {
			it(`${name}: hovered .btn-${v.name} label meets 4.5:1`, () => {
				const hoverSel =
					mode === 'light' ? `[data-theme='light'] .btn-${v.name}:hover` : `.btn-${v.name}:hover`;
				const { pct, toward } = hoverMix(hoverSel);
				const fill = blockToken(block, v.fill);
				const label = blockToken(block, v.label);
				const hovered = mixSrgb(fill, pct, toward);
				expect(contrast(label, hovered)).toBeGreaterThanOrEqual(4.5);
			});
		}
	}

	it('no .btn hover dims the label with opacity', () => {
		// The regression that caused #103.
		expect(css).not.toMatch(/\.btn[\w-]*:hover\s*\{[^}]*opacity/);
	});
});
