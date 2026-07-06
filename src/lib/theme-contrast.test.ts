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
	const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
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
});

describe('terracotta light theme WCAG AA contrast', () => {
	const sel = "[data-theme-id='terracotta'][data-theme='light']";
	const primary = blockToken(sel, 'primary');
	const primaryForeground = blockToken(sel, 'primary-foreground');
	const background = blockToken(sel, 'background');
	const card = blockToken(sel, 'card');
	const ring = blockToken(sel, 'ring');
	const destructive = blockToken(sel, 'destructive');
	const destructiveForeground = blockToken(sel, 'destructive-foreground');

	it('destructive text on the page background meets 4.5:1', () => {
		expect(contrast(destructive, background)).toBeGreaterThanOrEqual(4.5);
	});

	it('destructive text on cards meets 4.5:1', () => {
		expect(contrast(destructive, card)).toBeGreaterThanOrEqual(4.5);
	});

	it('destructive-foreground text on destructive buttons meets 4.5:1', () => {
		expect(contrast(destructiveForeground, destructive)).toBeGreaterThanOrEqual(4.5);
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
	const destructiveForeground = blockToken(sel, 'destructive-foreground');

	it('destructive text on the page background meets 4.5:1', () => {
		expect(contrast(destructive, background)).toBeGreaterThanOrEqual(4.5);
	});

	it('destructive text on cards meets 4.5:1', () => {
		expect(contrast(destructive, card)).toBeGreaterThanOrEqual(4.5);
	});

	it('destructive-foreground text on destructive buttons meets 4.5:1', () => {
		expect(contrast(destructiveForeground, destructive)).toBeGreaterThanOrEqual(4.5);
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
