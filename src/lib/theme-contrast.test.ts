import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEMES } from './themes';

// Guards WCAG AA contrast for the resting theme tokens (#76): the terracotta
// accent used as small-text foreground on the page background and on cards, and
// as the button background under --primary-foreground text, plus the destructive
// button (fill vs --destructive-foreground) for EVERY theme × mode. A future
// accent tweak that drops any asserted pairing below threshold fails here.
//
// Scope note: these #76 asserts cover the terracotta pairings in full and
// destructive everywhere; the other resting default/aurora pairings predate the
// AA work and are not asserted. The .btn hover states are asserted separately in
// the #103 describe block below (which DOES cover default/aurora hover).

const css = readFileSync(fileURLToPath(new URL('../app.css', import.meta.url)), 'utf8');

// Extracts a rule's body (the text between its braces). Anchored to a line start
// so a plain selector (e.g. [data-theme='light']) can't match the tail of a
// compound one ([data-theme-id='aurora'][data-theme='light']).
function blockBody(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const body = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
	if (!body) throw new Error(`${selector} block not found in app.css`);
	return body;
}

function blockToken(selector: string, name: string): string {
	const block = blockBody(selector);
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

// color-mix(in srgb, <hex> pct%, <other hex>) for opaque operands: interpolate
// the gamma-encoded channels toward the other color.
function mix2(hex: string, pct: number, other: string): string {
	const p = pct / 100;
	const o = comps(other);
	return toHex(comps(hex).map((v, i) => v * p + o[i] * (1 - p)));
}

// Pulls the color-mix percentage + endpoint out of the hover rule's fill. Throws
// if the rule is missing or isn't a srgb color-mix (e.g. an opacity-dim hover),
// so #103 can't silently regress.
function hoverMix(selector: string): { pct: number; toward: 'black' | 'white' } {
	const rule = blockBody(selector);
	const m = rule.match(
		/background-color:\s*color-mix\(in srgb,\s*var\(--[\w-]+\)\s*(\d+)%,\s*(black|white)\)/
	);
	if (!m) throw new Error(`${selector} has no srgb color-mix hover fill (opacity-dim hover reintroduced?)`);
	return { pct: Number(m[1]), toward: m[2] as 'black' | 'white' };
}

// Pulls the border-color color-mix out of the outline hover rule (border pct +
// the token it mixes toward). Throws if the rule stops shifting the border, so
// the #103 outline-dissolve fix can't silently regress.
function hoverBorderMix(selector: string): { pct: number; token: string } {
	const rule = blockBody(selector);
	const m = rule.match(
		/border-color:\s*color-mix\(in srgb,\s*var\(--border\)\s*(\d+)%,\s*var\(--([\w-]+)\)\)/
	);
	if (!m) throw new Error(`${selector} has no border-color color-mix (outline-dissolve fix reverted?)`);
	return { pct: Number(m[1]), token: m[2] };
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

	// Every rule block whose selector mentions .btn-destructive, base and hover
	// and theme-scoped alike. The old assertion used a non-global regex anchored
	// to the bare selector, so it only ever saw the base rule — a second block
	// setting color: #fff would have sailed through.
	const destructiveRules = [...css.matchAll(/^([^\n{]*\.btn-destructive[^\n{]*)\{([^}]*)\}/gm)].map(
		([, selector, body]) => ({ selector: selector.trim(), body })
	);

	it('finds every .btn-destructive rule block in app.css', () => {
		// Coverage pin: the base rule plus the two hover fills. A new block bumps
		// this and fails, forcing the color assertion below to be looked at.
		// Compared as a sorted set — reordering app.css is not a regression.
		expect(destructiveRules.map((r) => r.selector).sort()).toEqual(
			[
				'.btn-destructive',
				'.btn-destructive:hover',
				"[data-theme='light'] .btn-destructive:hover"
			].sort()
		);
	});

	it('every .btn-destructive block that sets a text color uses the token', () => {
		// The token assertions above are only meaningful if the rules actually
		// use the token; a refactor back to var(--foreground) reintroduces #76.
		// No fallback either: every theme block must define the token itself.
		// The hover blocks restyle only the fill and inherit the base color, so
		// they are checked for absence of a competing color rather than presence.
		for (const { selector, body } of destructiveRules) {
			const color = body.match(/(?:^|[;{]\s*)color:\s*([^;]+);/)?.[1]?.trim();
			if (color === undefined) continue;
			expect(`${selector} -> ${color}`).toBe(`${selector} -> var(--destructive-foreground)`);
		}
	});

	it('the base .btn-destructive rule does set the token', () => {
		// Guards the other direction: dropping the declaration entirely would make
		// the loop above vacuously pass.
		const base = destructiveRules.find((r) => r.selector === '.btn-destructive');
		expect(base?.body).toMatch(/color:\s*var\(--destructive-foreground\)\s*;/);
	});
});

describe('component CSS: destructive fills carry the destructive-foreground token', () => {
	// app.css is guarded above, but the same pairing is written by hand in route
	// components, where a literal (color: #fff / white) reads as correct against
	// the default red and then breaks on a theme whose --destructive is light.
	// Scans every .svelte file for a rule that fills with --destructive and also
	// sets a text color, and requires that color to be the token.
	//
	// SOLID fills only. A color-mix tint over transparent (the .sbadge soft-badge
	// pattern) is a different pairing: its text sits on the COMPOSITE of the tint
	// over the surface underneath (tint% of --destructive blended into the page
	// background or card), not on the bare page background, and
	// --destructive-foreground would be the wrong answer there. Tinted-banner
	// text is asserted against that real composite surface in the SONA-124
	// destructive-tint describe below (R3-A2).
	const srcDir = new URL('../', import.meta.url);
	// readdirSync recursive rather than fs.globSync, matching reactivity-guard.test.ts.
	const components = readdirSync(fileURLToPath(srcDir), { recursive: true })
		.map((p) => String(p))
		.filter((p) => p.endsWith('.svelte'))
		.sort();

	// Both declarations are matched loosely on purpose: `background` or
	// `background-color`, any whitespace (a prettier wrap puts the value on its
	// own line), and an omitted final semicolon. A stricter pattern doesn't fail —
	// it stops matching, and the rule drops out of the scan unnoticed.
	const DESTRUCTIVE_FILL = /background(?:-color)?:\s*var\(\s*--destructive\s*\)\s*(?:;|$)/;
	const TEXT_COLOR = /(?:^|[;{]\s*)color:\s*([^;]+?)\s*(?:;|$)/;

	const filled = components.flatMap((rel) => {
		const source = readFileSync(new URL(rel, srcDir), 'utf8');
		return [...source.matchAll(/^([^\n{]*)\{([^}]*)\}/gm)]
			.filter(([, , body]) => DESTRUCTIVE_FILL.test(body))
			.map(([, selector, body]) => ({ file: rel, selector: selector.trim(), body }));
	});

	// Accepted gap: a destructive fill that sets NO color at all inherits its text
	// color and is invisible to this scan.
	for (const { file, selector, body } of filled) {
		const color = body.match(TEXT_COLOR)?.[1];
		if (color === undefined) continue;
		it(`${file} ${selector} colors its text with the token`, () => {
			expect(color).toBe('var(--destructive-foreground)');
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

describe('aurora light theme WCAG AA contrast', () => {
	const sel = "[data-theme-id='aurora'][data-theme='light']";
	const card = blockToken(sel, 'card');
	const destructive = blockToken(sel, 'destructive');
	const destructiveForeground = blockToken(sel, 'destructive-foreground');

	it('destructive text on cards meets 4.5:1', () => {
		expect(contrast(destructive, card)).toBeGreaterThanOrEqual(4.5);
	});

	it('destructive-foreground text on destructive buttons meets 4.5:1', () => {
		expect(contrast(destructiveForeground, destructive)).toBeGreaterThanOrEqual(4.5);
	});
});

// Ember light --destructive is used as field-error text on the page background
// (e.g. the supporter-key error, SONA-105). The mock #D93C15 was 4.09:1 there and
// failed AA; #BE320E clears it. Guards a revert to the failing color.
describe('ember light theme WCAG AA contrast', () => {
	const sel = "[data-theme='light']";
	const destructive = blockToken(sel, 'destructive');
	const background = blockToken(sel, 'background');
	const card = blockToken(sel, 'card');

	it('destructive text on the page background meets 4.5:1', () => {
		expect(contrast(destructive, background)).toBeGreaterThanOrEqual(4.5);
	});

	it('destructive text on cards meets 4.5:1', () => {
		expect(contrast(destructive, card)).toBeGreaterThanOrEqual(4.5);
	});
});

// Resting-state AA for every theme × mode: the #76 asserts above cover the primary
// pairing only for terracotta, and via the button label. Each .btn variant's label
// must clear 4.5:1 on its un-hovered fill: primary/secondary use their own fg token,
// outline uses --foreground on --background. A resting regression like the aurora
// dark primary drop (#121) fails here; terracotta light primary (4.68:1) sits
// closest to the floor. Scope: assert only; do not tune colors to pass — a new
// failure is a finding to report, not to silence.
// Every theme × mode block in app.css, shared by the resting-state and
// focus-ring describes below (was copy-pasted three times).
const THEME_BLOCKS = [
	{ name: 'ember dark', sel: ':root' },
	{ name: 'ember light', sel: "[data-theme='light']" },
	{ name: 'aurora dark', sel: "[data-theme-id='aurora']" },
	{ name: 'aurora light', sel: "[data-theme-id='aurora'][data-theme='light']" },
	{ name: 'terracotta dark', sel: "[data-theme-id='terracotta']" },
	{ name: 'terracotta light', sel: "[data-theme-id='terracotta'][data-theme='light']" }
];

describe('resting .btn WCAG AA contrast — every theme × variant × mode (#121)', () => {
	const variants = [
		{ name: 'primary', fill: 'primary', label: 'primary-foreground' },
		{ name: 'secondary', fill: 'secondary', label: 'secondary-foreground' },
		{ name: 'outline', fill: 'background', label: 'foreground' }
	];

	for (const { name, sel } of THEME_BLOCKS) {
		for (const v of variants) {
			it(`${name}: resting .btn-${v.name} label meets 4.5:1`, () => {
				const fill = blockToken(sel, v.fill);
				const label = blockToken(sel, v.label);
				expect(contrast(label, fill)).toBeGreaterThanOrEqual(4.5);
			});
		}
	}
});

// The .btn:focus-visible ring sits on the page background (2px outline-offset), so
// it's non-text UI held to 3:1. It must use --ring, not --primary: --primary drops
// to 2.20:1 on Ember light. Assert the rule keeps the --ring token and that --ring
// clears 3:1 on --background in every theme × mode (#121).
// The ring must clear 3:1 on BOTH resting surfaces it appears over: the page
// background (.btn:focus-visible, 2px outline-offset — #121) and the card.
// (The DownloadMenu row ring is NOT covered here: it sits on the menu's LIFTED
// card-toward-white surface, where --ring fails on ember dark — it uses
// --foreground instead, asserted in the SONA-123 describe at the bottom.)
describe('focus ring WCAG AA contrast, every theme × surface × mode (#121, SONA-123)', () => {
	it('the ring uses var(--ring) (not var(--primary), which fails 3:1 on Ember light)', () => {
		const rule = css.match(/^\.btn:focus-visible\s*\{([^}]*)\}/m)?.[1];
		if (!rule) throw new Error('.btn:focus-visible rule not found in app.css');
		expect(rule).toMatch(/outline:[^;]*var\(--ring\)/);
	});

	for (const surface of ['background', 'card'] as const) {
		for (const { name, sel } of THEME_BLOCKS) {
			it(`${name}: focus ring against the ${surface} surface meets 3:1`, () => {
				expect(contrast(blockToken(sel, 'ring'), blockToken(sel, surface))).toBeGreaterThanOrEqual(3);
			});
		}
	}
});

// --muted-foreground is not only hint TEXT: it's the resting color of the social
// icons, the copy button, the select chevron and other icon-only affordances,
// which WCAG 1.4.11 (non-text contrast) holds to 3:1 against their background.
// Every pairing currently clears it with room to spare — the tightest is
// terracotta light on --background at 4.53:1 — so this is a pin against a future
// token tweak, not a fix. A failure here is a finding to report, not to silence
// by tuning the assertion.
describe('muted-foreground non-text contrast, every theme × surface × mode (WCAG 1.4.11)', () => {
	for (const surface of ['background', 'card'] as const) {
		for (const { name, sel } of THEME_BLOCKS) {
			it(`${name}: icons colored --muted-foreground meet 3:1 on the ${surface} surface`, () => {
				expect(
					contrast(blockToken(sel, 'muted-foreground'), blockToken(sel, surface))
				).toBeGreaterThanOrEqual(3);
			});
		}
	}
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

	// The outline hover fill lands next to --border, so the hover also pulls the
	// border toward --foreground to keep the 1px outline from dissolving into a
	// solid fill (#103 designer finding). Assert the hovered border stays visibly
	// distinct from the hovered fill in every theme × mode — a plain dissolve sits
	// near 1:1, so 1.5:1 is a comfortable floor above it.
	for (const { name, block, mode } of themeBlocks) {
		it(`${name}: hovered .btn-outline border stays distinct from the fill`, () => {
			const hoverSel =
				mode === 'light' ? "[data-theme='light'] .btn-outline:hover" : '.btn-outline:hover';
			const { pct: fillPct, toward } = hoverMix(hoverSel);
			const fill = mixSrgb(blockToken(block, 'background'), fillPct, toward);
			// The border-color shift lives on the base rule and cascades to both modes.
			const { pct: borderPct, token } = hoverBorderMix('.btn-outline:hover');
			const border = mix2(blockToken(block, 'border'), borderPct, blockToken(block, token));
			expect(contrast(border, fill)).toBeGreaterThanOrEqual(1.5);
		});
	}

	it('no .btn hover dims the label with opacity', () => {
		// The regression that caused #103.
		expect(css).not.toMatch(/\.btn[\w-]*:hover\s*\{[^}]*opacity/);
	});
});

// The DownloadMenu list floats on a LIFTED surface — color-mix of --card toward
// white — not raw --card, and its rows hover with a secondary→foreground mix
// (SONA-123). The card-surface ring checks above miss both: --ring sat at
// ~2.1:1 on ember dark's lifted surface, and --muted-foreground hint text
// failed 4.5:1 on the hover fill in all six theme × mode blocks. Parse the
// actual mixes and color tokens out of the component's CSS (so changing either
// side incompatibly fails here) and assert: (a) the row focus ring clears 3:1
// on the lifted surface; (b) the row label AND the hint clear 4.5:1 on both the
// lifted surface and the hover fill.
describe('DownloadMenu lifted-surface WCAG AA contrast, every theme × mode (SONA-123)', () => {
	const menuCss = readFileSync(
		fileURLToPath(new URL('./components/DownloadMenu.svelte', import.meta.url)),
		'utf8'
	);

	function extract(re: RegExp, what: string): string {
		const m = menuCss.match(re)?.[1];
		if (!m) throw new Error(`${what} not found in DownloadMenu.svelte (mix or token changed?)`);
		return m;
	}

	// The lifted surface: color-mix(in srgb, var(--card) <pct>%, white).
	const surfacePct = Number(
		extract(
			/background:\s*color-mix\(in srgb,\s*var\(--card\)\s*(\d+)%,\s*white\)/,
			'lifted menu-surface card→white color-mix'
		)
	);
	// The row hover fill: color-mix(in srgb, var(--secondary) <pct>%, var(--foreground)).
	const hoverPct = Number(
		extract(
			/background:\s*color-mix\(in srgb,\s*var\(--secondary\)\s*(\d+)%,\s*var\(--foreground\)\)/,
			'row hover secondary→foreground color-mix'
		)
	);
	const ringToken = extract(
		/\.dl-list a:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--([\w-]+)\)/,
		'row focus-ring outline token'
	);
	const hintToken = extract(/\.hint\s*\{[^}]*color:\s*var\(--([\w-]+)\)/, '.hint color token');

	for (const { name, sel } of THEME_BLOCKS) {
		const lifted = () => mixSrgb(blockToken(sel, 'card'), surfacePct, 'white');
		const hovered = () => mix2(blockToken(sel, 'secondary'), hoverPct, blockToken(sel, 'foreground'));

		it(`${name}: row focus ring meets 3:1 on the lifted menu surface`, () => {
			expect(contrast(blockToken(sel, ringToken), lifted())).toBeGreaterThanOrEqual(3);
		});

		it(`${name}: row label and hint meet 4.5:1 on the lifted surface AND the hover fill`, () => {
			for (const surface of [lifted(), hovered()]) {
				expect(contrast(blockToken(sel, 'foreground'), surface)).toBeGreaterThanOrEqual(4.5);
				expect(contrast(blockToken(sel, hintToken), surface)).toBeGreaterThanOrEqual(4.5);
			}
		});
	}
});

describe('public chip text (foreground on secondary) WCAG AA contrast (SONA-124)', () => {
	// The VR pages' chips (platform/format/role) render --foreground on
	// --secondary: the --muted-foreground pairing they replaced was 3.96:1 on
	// TERRACOTTA light (Ember light passes at 4.67:1). Guard the replacement
	// pairing in every theme × mode so a token tweak can't quietly sink the
	// chips again.
	for (const { name, sel } of THEME_BLOCKS) {
		it(`${name}: foreground on secondary meets 4.5:1`, () => {
			expect(contrast(blockToken(sel, 'foreground'), blockToken(sel, 'secondary'))).toBeGreaterThanOrEqual(4.5);
		});
	}
});

describe('SONA-124 chip CSS keeps the --foreground token (R2-A3)', () => {
	// The token pairing above only matters while the components actually USE
	// the token: a revert to color: var(--muted-foreground) in any chip rule
	// would pass every token assertion and still ship the 3.96:1 terracotta
	// failure. Parse the component source like the DownloadMenu describe.
	const chipRules: Array<{ file: string; selector: string }> = [
		{ file: '../routes/(public)/vr/+page.svelte', selector: '.platform-chip' },
		{ file: '../routes/(public)/vr/[slug]/+page.svelte', selector: '.chip' },
		{ file: '../routes/(public)/vr/[slug]/+page.svelte', selector: '.role-chip' },
		{ file: '../routes/admin/vr/+page.svelte', selector: '.model-chip' },
		{ file: '../routes/admin/vr/+page.svelte', selector: '.vis-chip' }
	];

	for (const { file, selector } of chipRules) {
		it(`${file} ${selector} colors its text with var(--foreground)`, () => {
			const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
			const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const body = source.match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
			if (!body) throw new Error(`${selector} rule not found in ${file}`);
			expect(body).toMatch(/color:\s*var\(--foreground\)\s*;/);
		});
	}
});

// The SONA-124 destructive-tint banners (.banner.err in VrAvatarForm,
// .load-error in VrViewer) paint text over color-mix(--destructive N%,
// transparent). The REAL text surface is that tint composited over whatever
// sits underneath (page background or card) — --destructive text on it fell
// below 4.5:1 on three light themes (R3-A2), so the text is --foreground and
// only the tint + icon stay destructive. Parse the actual tint percentage and
// text token out of each component (a revert to color: var(--destructive)
// fails the token pin; a tint-percentage change re-runs the math) and assert
// the composite pairing for every theme × mode.
describe('SONA-124 destructive-tint banner text on its composite surface (R3-A2)', () => {
	const banners: Array<{ file: string; selector: string }> = [
		{ file: './components/VrAvatarForm.svelte', selector: '.banner.err' },
		{ file: './components/VrViewer.svelte', selector: '.load-error' }
	];

	for (const { file, selector } of banners) {
		const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const body = source.match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
		if (!body) throw new Error(`${selector} rule not found in ${file}`);
		const tintPct = Number(
			body.match(
				/background:\s*color-mix\(in srgb,\s*var\(--destructive\)\s*(\d+)%,\s*transparent\)/
			)?.[1]
		);
		const textToken = body.match(/color:\s*var\(--([\w-]+)\)/)?.[1];

		it(`${file} ${selector} keeps the destructive tint and --foreground text`, () => {
			if (!Number.isFinite(tintPct)) throw new Error(`${selector} lost its destructive tint`);
			expect(textToken).toBe('foreground');
		});

		for (const surface of ['background', 'card'] as const) {
			for (const { name, sel } of THEME_BLOCKS) {
				it(`${name}: ${selector} text meets 4.5:1 on the tint over the ${surface}`, () => {
					if (!textToken) throw new Error(`${selector} sets no text color token`);
					const composite = mix2(blockToken(sel, 'destructive'), tintPct, blockToken(sel, surface));
					expect(contrast(blockToken(sel, textToken), composite)).toBeGreaterThanOrEqual(4.5);
				});
			}
		}
	}
});

// The VR export guide and the avatar form's guide link color small text with
// --status-attention precisely BECAUSE --primary fails AA on ember light
// (2.20:1) — the SONA-162 CSS comments assert the token passes 4.5:1 in every
// theme × mode, and until here nothing pinned that. The token resolves lazily:
// a block either declares a hex or falls through (var(--primary) or no
// declaration at all) to its own --primary, so re-pointing any theme's
// attention color at an AA-failing value sinks the guide's eyebrow, its
// highlighted table value, and the form's guide link silently.
describe('status-attention small-text WCAG AA contrast, every theme × surface × mode (SONA-162)', () => {
	function statusAttention(sel: string): string {
		const body = blockBody(sel);
		const hex = body.match(/--status-attention:\s*(#[0-9A-Fa-f]{6})\s*;/)?.[1];
		return hex ?? blockToken(sel, 'primary');
	}
	for (const surface of ['background', 'card'] as const) {
		for (const { name, sel } of THEME_BLOCKS) {
			it(`${name}: --status-attention text meets 4.5:1 on the ${surface} surface`, () => {
				expect(contrast(statusAttention(sel), blockToken(sel, surface))).toBeGreaterThanOrEqual(4.5);
			});
		}
	}
});
