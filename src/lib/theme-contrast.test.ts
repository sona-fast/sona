import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_THEMES } from './themes/all.ts';
import { resolveToken, type ThemeMode } from './themes/cascade.ts';
import { TOKEN_CSS_NAMES, cssName, type TokenKey } from './themes/types.ts';
import { themeSelectors } from '../../scripts/build-themes.ts';

// Guards WCAG AA contrast for the resting theme tokens (#76): the terracotta
// accent used as small-text foreground on the page background and on cards, and
// as the button background under --primary-foreground text, plus the destructive
// button (fill vs --destructive-foreground) for EVERY theme × mode. A future
// accent tweak that drops any asserted pairing below threshold fails here.
//
// Scope note: these #76 asserts cover the terracotta pairings in full and
// destructive everywhere; the other resting default/aurora pairings predate the
// AA work. The generic sweep at the bottom of this file (SONA-209) covers the
// rest of the resting surface pairings for every theme × mode. The .btn hover
// states are asserted separately in the #103 describe block below.
//
// Token values come from the theme DATA (src/lib/themes/*.theme.ts), which is
// also what generates the CSS — so this file measures the same numbers the
// browser gets. Only rules that are still hand-written (the .btn blocks, the
// component styles) are read out of the stylesheets.

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

// The same read against a component source file: the describes below parse the
// tint rules out of the components that paint them, so a rule that moves or
// stops matching fails here instead of dropping silently out of a sweep.
function ruleBody(file: string, selector: string): string {
	const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const body = source.match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
	if (!body) throw new Error(`${selector} rule not found in ${file}`);
	return body;
}

// One self-tint rule: `background: color-mix(in srgb, var(--<ink>) N%,
// transparent)` plus the token its label is painted with. The percentage may be
// fractional, and the label is anchored to a declaration boundary so a rule
// whose FIRST declaration is `color:` still parses while `border-color:` still
// does not.
// `where` names the rule in the failure, so a component that stops self-tinting
// says which one rather than leaving the reader to find it among the rows below.
function selfTint(body: string, where = 'rule'): { ink: string; pct: number; label: string | undefined } {
	const tint = body.match(
		/background:\s*color-mix\(in srgb,\s*var\(--([\w-]+)\)\s*(\d+(?:\.\d+)?)%,\s*transparent\)/
	);
	if (!tint) throw new Error(`${where} no longer tints with a color-mix over transparent`);
	return {
		ink: tint[1],
		pct: Number(tint[2]),
		label: body.match(/(?:^|[;{])\s*color:\s*var\(--([\w-]+)\)/)?.[1]
	};
}

describe('selfTint rule parsing', () => {
	it('parses a rule whose first declaration is the label color', () => {
		const { ink, pct, label } = selfTint(
			'\n\tcolor: var(--status-ok);\n\tbackground: color-mix(in srgb, var(--status-ok) 14%, transparent);\n'
		);
		expect({ ink, pct, label }).toEqual({ ink: 'status-ok', pct: 14, label: 'status-ok' });
	});

	it('parses a fractional tint percentage', () => {
		const { pct } = selfTint(
			'\n\tbackground: color-mix(in srgb, var(--destructive) 12.5%, transparent);\n\tcolor: var(--foreground);\n'
		);
		expect(pct).toBe(12.5);
	});

	it('does not read a border-color declaration as the label', () => {
		const { label } = selfTint(
			'\n\tborder-color: var(--border);\n\tbackground: color-mix(in srgb, var(--destructive) 20%, transparent);\n'
		);
		expect(label).toBeUndefined();
	});

	it('names the rule when it no longer tints', () => {
		expect(() => selfTint('\n\tbackground: var(--card);\n', './components/X.svelte .chip')).toThrow(
			'./components/X.svelte .chip no longer tints'
		);
	});
});

type Mode = ThemeMode;

/** The selector the generator emits for one theme × mode (build-themes.ts). */
function selectorFor(theme: (typeof ALL_THEMES)[number], mode: Mode): string {
	return themeSelectors(theme)[mode];
}

// Selector → the theme block it is generated from. The selectors are the ones
// the rest of this file already names; keeping them as the lookup key means the
// describes below read tokens the same way they always did.
const BLOCK_BY_SELECTOR = new Map<string, { id: string; mode: Mode }>(
	ALL_THEMES.flatMap((theme) =>
		(['dark', 'light'] as Mode[]).map(
			(mode) => [selectorFor(theme, mode), { id: theme.id, mode }] as const
		)
	)
);

// Every theme × mode block in app.css, shared by the describes below (it was
// copy-pasted three times). Derived from BLOCK_BY_SELECTOR (and so from the
// generator's own selectors) rather than hardcoded, so a new theme is
// enumerated automatically — a hardcoded list would let it skip the per-block
// --link declaration guard and inherit another theme's link color through the
// shared [data-theme='light'] selector. `name` labels the default theme by its
// palette name (ember); the describes that predate the sweep spell their own
// names out of `id` and `mode`.
const THEME_BLOCKS = [...BLOCK_BY_SELECTOR].map(([sel, { id, mode }]) => ({
	name: `${id === 'default' ? 'ember' : id} ${mode}`,
	id,
	mode,
	sel
}));

const TOKEN_BY_CSS_NAME = new Map<string, TokenKey>(
	Object.entries(TOKEN_CSS_NAMES).map(([key, name]) => [name.slice(2), key as TokenKey])
);

// The hex one token resolves to on one theme × mode. The cascade itself lives in
// ./themes/cascade.ts, which the generator also uses, so the chain this measures
// and the chain that renders the CSS cannot drift apart. Hex-only: every pairing
// asserted here is a contrast measurement, and rgba()/var() would give a
// silently wrong number rather than an error.
function themeHex(id: string, mode: Mode, key: TokenKey): string {
	const value = resolveToken(ALL_THEMES, id, mode, key);
	if (value === undefined) {
		throw new Error(`${id} ${mode}: ${cssName(key)} is not declared in any matching block`);
	}
	if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
		throw new Error(`${cssName(key)} resolves to '${value}' on ${id} ${mode}, not a 6-digit hex`);
	}
	return value;
}

// The same read by generated-block SELECTOR, which is how every describe that
// predates the sweep names a theme × mode.
function blockHex(selector: string, key: TokenKey): string {
	const block = BLOCK_BY_SELECTOR.get(selector);
	if (!block) throw new Error(`${selector} is not a generated theme block`);
	return themeHex(block.id, block.mode, key);
}

// The same read by CSS custom-property name, the way the old regex over app.css
// did it. The describes that predate the sweep name tokens that way, so this is
// the string adapter for them; new code takes the key.
function blockToken(selector: string, name: string): string {
	const key = TOKEN_BY_CSS_NAME.get(name);
	if (!key) throw new Error(`--${name} is not a theme token`);
	return blockHex(selector, key);
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

// Pulls the border-color color-mix out of the outline hover rule: the base token
// it mixes FROM, the percentage, and the token it mixes toward. The base is read
// rather than assumed — SONA-126 moved the resting border from --border to
// --input and the hover followed, and a measurement against the wrong base would
// have gone on passing. Throws if the rule stops shifting the border, so the #103
// outline-dissolve fix can't silently regress.
function hoverBorderMix(selector: string): { base: string; pct: number; token: string } {
	const rule = blockBody(selector);
	const m = rule.match(
		/border-color:\s*color-mix\(in srgb,\s*var\(--([\w-]+)\)\s*(\d+)%,\s*var\(--([\w-]+)\)\)/
	);
	if (!m) throw new Error(`${selector} has no border-color color-mix (outline-dissolve fix reverted?)`);
	return { base: m[1], pct: Number(m[2]), token: m[3] };
}

describe('destructive button WCAG AA contrast, every theme × mode', () => {
	// The default theme lives on :root / [data-theme='light']; alternate themes
	// on [data-theme-id='<id>'] and its [data-theme='light'] variant — all of
	// which the generator already spells out, so take them from THEME_BLOCKS
	// rather than from a copy that can drift.
	for (const { id, mode, sel } of THEME_BLOCKS) {
		const name = `${id} ${mode}`;
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
// SONA-209: the resting surface pairings, swept over the theme DATA rather than
// picked one at a time. Everything above grew pairing-by-pairing out of a bug
// report, so a palette could (and did) carry combinations nothing measured. This
// iterates every theme × mode and checks the pairings that hold for all of them:
// text on its surface at 4.5:1, and the two non-text tokens at 3:1.
//
// Scope: raw --primary as TEXT is deliberately absent. It fails on Ember light
// (2.20:1), which is why --link, --status-attention and now --primary-text
// (SONA-126) exist; --primary-text is swept at 4.5:1 below. --primary itself is
// swept at the 3:1 non-text floor, where it draws selection and drop-target
// borders.
//
// Scope: only --sidebar-border is out of the sweep. Its dark value is an alpha
// value (rgba over whatever sits behind it), and this sweep measures opaque
// pairs only — compositing it would be a second mechanism, not another row in
// this table. --sidebar and --sidebar-foreground are opaque hexes and ARE
// swept below.
const RESTING_PAIRS: Array<{ ink: TokenKey; ground: TokenKey; floor: number }> = [
	{ ink: 'foreground', ground: 'background', floor: 4.5 },
	{ ink: 'foreground', ground: 'card', floor: 4.5 },
	{ ink: 'cardForeground', ground: 'card', floor: 4.5 },
	{ ink: 'mutedForeground', ground: 'background', floor: 4.5 },
	{ ink: 'mutedForeground', ground: 'card', floor: 4.5 },
	// Chips and pills: muted label on the --secondary fill, live in the admin
	// pages today. Re-pointing those uses at a darker token is the palette step.
	{ ink: 'mutedForeground', ground: 'secondary', floor: 4.5 },
	// --muted is where those same chips and rows go on hover (the gallery
	// character chips, the about page's convention rows), so the muted label sits
	// on it for as long as the pointer is there. Terracotta light fails it today,
	// like the resting --secondary pairing above.
	{ ink: 'mutedForeground', ground: 'muted', floor: 4.5 },
	// The admin shell's nav: the active/heading label uses --sidebar-foreground,
	// the resting links --muted-foreground, both on the --sidebar fill
	// (src/routes/admin/+layout.svelte).
	{ ink: 'sidebarForeground', ground: 'sidebar', floor: 4.5 },
	{ ink: 'mutedForeground', ground: 'sidebar', floor: 4.5 },
	{ ink: 'link', ground: 'background', floor: 4.5 },
	{ ink: 'link', ground: 'card', floor: 4.5 },
	// --primary-text is --primary in its small-text role (SONA-126): headings,
	// eyebrows, counts, chip labels. Same 4.5:1 floor as --link, on both surfaces
	// a label sits on.
	{ ink: 'primaryText', ground: 'background', floor: 4.5 },
	{ ink: 'primaryText', ground: 'card', floor: 4.5 },
	{ ink: 'statusOk', ground: 'card', floor: 4.5 },
	{ ink: 'statusWarn', ground: 'card', floor: 4.5 },
	// The same two status inks also label rows that sit straight on the page (the
	// storage breakdown, the settings status lines), not only on cards.
	{ ink: 'statusOk', ground: 'background', floor: 4.5 },
	{ ink: 'statusWarn', ground: 'background', floor: 4.5 },
	{ ink: 'statusAttention', ground: 'card', floor: 4.5 },
	{ ink: 'destructiveForeground', ground: 'destructive', floor: 4.5 },
	{ ink: 'primaryForeground', ground: 'primary', floor: 4.5 },
	// The other two foreground/fill pairs the palettes declare. Both clear AA
	// comfortably today (9.07:1 at the worst), so they are pinned rather than
	// fixed — nothing here tunes a colour.
	{ ink: 'secondaryForeground', ground: 'secondary', floor: 4.5 },
	{ ink: 'accentForeground', ground: 'accent', floor: 4.5 },
	{ ink: 'border', ground: 'background', floor: 3 },
	{ ink: 'border', ground: 'card', floor: 3 },
	{ ink: 'ring', ground: 'background', floor: 3 },
	// --input is the form-field boundary, in both places a field sits: on the
	// page and inside a card. WCAG 1.4.11 wants 3:1 of it.
	{ ink: 'input', ground: 'background', floor: 3 },
	{ ink: 'input', ground: 'card', floor: 3 },
	// --primary is not only a fill: it draws the selected-item and drop-target
	// borders, which are non-text state indicators and so 1.4.11 at 3:1. Fixing
	// the light-Ember case is SONA-126.
	{ ink: 'primary', ground: 'background', floor: 3 },
	{ ink: 'primary', ground: 'card', floor: 3 }
];

// Pairings that fail TODAY, allowlisted with the ratio measured when the sweep
// was written so the debt is visible instead of silencing the assertion. No
// palette value was changed to make this suite green (SONA-209).
//
// WCAG 1.4.11 asks 3:1 of a boundary only where the boundary is what identifies
// a control or its state. SONA-126 split the two uses apart:
//
//   • CONTROLS now clear 1.4.11. `.input` draws the form-field boundary with
//     --input, and `.btn-outline` now draws its only boundary with --input too
//     (it used --border). Every palette × mode raised --input to at least 3.2:1
//     on both --background and --card, so neither has an entry below any more.
//   • DECORATIVE hairlines are what is left. --border draws the card and table
//     rules — a line between two adjacent surfaces of the same family,
//     identifying nothing — so 1.4.11 does not apply and the ratios stay
//     recorded here rather than silenced.
//
// Same for --primary as a selection/drop-target border on light Ember: that one
// is still real debt, recorded rather than tuned.
const KNOWN_FAILURES = new Map<string, number>([
	['default dark border on background', 1.39],
	['default light border on background', 1.45],
	['aurora dark border on background', 1.43],
	['aurora light border on background', 1.29],
	['terracotta dark border on background', 1.39],
	['terracotta light border on background', 1.38],
	['default dark border on card', 1.28],
	['default light border on card', 1.61],
	['aurora dark border on card', 1.32],
	['aurora light border on card', 1.4],
	['terracotta dark border on card', 1.26],
	['terracotta light border on card', 1.82],
	['default light primary on background', 2.2],
	['default light primary on card', 2.46],
	['terracotta light mutedForeground on secondary', 3.96],
	// The hover twin of the pairing above, and it fails for the same reason.
	['terracotta light mutedForeground on muted', 4.11],
	// The admin nav's resting labels on the same palette, same cause: terracotta
	// light's --muted-foreground is too pale for its warm mid-tone surfaces.
	['terracotta light mutedForeground on sidebar', 3.96]
]);

// The sweep walks the theme DATA, not the selector list: every theme × mode,
// named by the id + mode that also form its KNOWN_FAILURES key, so a failure
// message names the exact entry to add or drop.
const SWEEP_BLOCKS = [...BLOCK_BY_SELECTOR.values()];

describe('resting token pairings, every theme × mode (SONA-209)', () => {
	// An allowlist key the sweep never generates — a renamed token, a dropped
	// pairing, a typo — silences nothing and reads as debt that is still there.
	it('has no KNOWN_FAILURES entry the sweep does not generate', () => {
		const generated = new Set(
			SWEEP_BLOCKS.flatMap(({ id, mode }) =>
				RESTING_PAIRS.map(({ ink, ground }) => `${id} ${mode} ${ink} on ${ground}`)
			)
		);
		expect([...KNOWN_FAILURES.keys()].filter((k) => !generated.has(k))).toEqual([]);
	});

	for (const { id, mode } of SWEEP_BLOCKS) {
		for (const { ink, ground, floor } of RESTING_PAIRS) {
			const key = `${id} ${mode} ${ink} on ${ground}`;
			it(`${id} ${mode}: --${ink} on --${ground} meets ${floor}:1`, () => {
				const ratio = contrast(themeHex(id, mode, ink), themeHex(id, mode, ground));
				const known = KNOWN_FAILURES.get(key);
				if (known !== undefined) {
					// Self-cleaning: once the pairing clears its floor, the allowlist
					// entry is stale and has to go, or it hides the next regression.
					expect(
						ratio,
						`${id} ${mode}: --${ink} on --${ground} now measures ${ratio.toFixed(2)}:1 and clears ${floor}:1 — drop it from KNOWN_FAILURES`
					).toBeLessThan(floor);
					expect(
						ratio,
						`${id} ${mode}: --${ink} on --${ground} moved from the recorded ${known}:1 to ${ratio.toFixed(2)}:1 and still fails ${floor}:1 — update its KNOWN_FAILURES ratio to the new measurement`
					).toBeCloseTo(known, 1);
					return;
				}
				expect(
					ratio,
					`${id} ${mode}: --${ink} on --${ground} measures ${ratio.toFixed(2)}:1, under the ${floor}:1 floor`
				).toBeGreaterThanOrEqual(floor);
			});
		}
	}
});

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
// icons, the copy button and other icon-only affordances, which WCAG 1.4.11
// (non-text contrast) holds to 3:1 against their background.
//
// The select chevron is NOT one of them, despite sitting on `select.input`: it
// is an SVG data URI in app.css painted with a hardcoded #9ca3af (a data URI
// can't read a custom property), so it neither follows this token nor changes
// with the theme, and nothing here measures it. Moving it onto a token is the
// palette step (SONA-126); this change alters no colour.
//
// Recorded so the debt has a number rather than a shrug: on the LIGHT page
// backgrounds #9ca3af measures 2.28:1 (ember), 2.34:1 (aurora) and 1.92:1
// (terracotta) — all under the 3:1 that 1.4.11 asks of the glyph that says a
// field is a dropdown. The dark modes pass. Measured 2026-09-14 against the
// theme data; re-measure rather than trust these once a palette moves.
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

// The refused-link hint under the Tags field is coloured --status-warn, the same
// token the suggestion tray's eyebrow uses (SONA-220). It is small text on the
// admin form's card, so it is held to 4.5:1 there. --status-warn is declared once
// per MODE (:root for dark, [data-theme='light'] for light) and inherited by the
// alternate themes, so the colour comes from the mode block and the surface from
// the theme's own block. A failure here is a finding to report, not to silence.
describe('warn text WCAG AA contrast on cards, every theme × mode (SONA-220)', () => {
	const warnFor = (sel: string) =>
		blockToken(sel.includes("[data-theme='light']") ? "[data-theme='light']" : ':root', 'status-warn');

	for (const surface of ['background', 'card'] as const) {
		for (const { name, sel } of THEME_BLOCKS) {
			it(`${name}: text colored --status-warn meets 4.5:1 on the ${surface} surface`, () => {
				expect(contrast(warnFor(sel), blockToken(sel, surface))).toBeGreaterThanOrEqual(4.5);
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
	// attribute, so one override branch serves them all). The blocks themselves
	// come from the generator's own selectors, not a hardcoded copy.
	for (const { id, mode, sel } of THEME_BLOCKS) {
		const name = `${id} ${mode}`;
		for (const v of variants) {
			it(`${name}: hovered .btn-${v.name} label meets 4.5:1`, () => {
				const hoverSel =
					mode === 'light' ? `[data-theme='light'] .btn-${v.name}:hover` : `.btn-${v.name}:hover`;
				const { pct, toward } = hoverMix(hoverSel);
				const fill = blockToken(sel, v.fill);
				const label = blockToken(sel, v.label);
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
	for (const { id, mode, sel } of THEME_BLOCKS) {
		const name = `${id} ${mode}`;
		it(`${name}: hovered .btn-outline border stays distinct from the fill`, () => {
			const hoverSel =
				mode === 'light' ? "[data-theme='light'] .btn-outline:hover" : '.btn-outline:hover';
			const { pct: fillPct, toward } = hoverMix(hoverSel);
			const fill = mixSrgb(blockToken(sel, 'background'), fillPct, toward);
			// The border-color shift lives on the base rule and cascades to both modes.
			const { base, pct: borderPct, token } = hoverBorderMix('.btn-outline:hover');
			const border = mix2(blockToken(sel, base), borderPct, blockToken(sel, token));
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

// SONA-115 puts the live convention row on a primary wash and its pill on solid
// primary: `color-mix(in srgb, var(--primary) 8%, transparent)` over the page
// background, and --primary-foreground on --primary. Neither pairing was pinned
// anywhere: the wash is a NEW surface (the same one /connect's here-now block
// uses), and --primary-foreground on --primary was only ever asserted for
// terracotta. Both are asserted here for every theme × mode.
describe('SONA-115 live-row wash and live pill WCAG AA contrast', () => {
	// The wash is mixed over transparent, so its real surface is the composite
	// with whatever it sits on, which for a table row is the page background.
	const WASH_PCT = 8;

	for (const { name, sel } of THEME_BLOCKS) {
		it(`${name}: row text meets 4.5:1 on the live wash over the background`, () => {
			const washed = mix2(blockToken(sel, 'primary'), WASH_PCT, blockToken(sel, 'background'));
			expect(contrast(blockToken(sel, 'foreground'), washed)).toBeGreaterThanOrEqual(4.5);
		});

		it(`${name}: the live pill's label meets 4.5:1 on solid primary`, () => {
			expect(
				contrast(blockToken(sel, 'primary-foreground'), blockToken(sel, 'primary'))
			).toBeGreaterThanOrEqual(4.5);
		});
	}
});

// SONA-210 puts the operator's pronouns in /connect's here-now block, whose
// ground is a primary wash over --card. The line is deliberately NOT the flat
// --muted-foreground the rest of the page uses (it reads dull on that ground):
// it mixes a little primary back in, which moves it TOWARD the ground it sits
// on and is exactly the kind of change that quietly sinks below AA. Parse both
// mixes out of the component, per the DownloadMenu precedent, and check the ink
// against both ends of the gradient — the strongest tint at the top of the
// block, and the plain card the gradient fades to.
describe('SONA-210 /connect pronouns ink on the here-now wash, every theme × mode', () => {
	const connectCss = readFileSync(
		fileURLToPath(new URL('../routes/(paths)/connect/+page.svelte', import.meta.url)),
		'utf8'
	);

	function pct(re: RegExp, what: string): number {
		const found = connectCss.match(re)?.[1];
		if (!found) throw new Error(`${what} not found in connect/+page.svelte (mix changed?)`);
		return Number(found);
	}

	// The ink: color-mix(in srgb, var(--primary) <pct>%, var(--muted-foreground)).
	// All three muted lines on this card share the tint, so all three are parsed
	// and checked. .here-through is 11px uppercase, which is still normal text
	// under WCAG (bold starts at 14pt/18.66px), so 4.5:1 applies to it too.
	const inkPcts = ['here-pronouns', 'here-loc', 'here-through'].map((cls) => ({
		cls,
		pct: pct(
			new RegExp(
				`\\.${cls}\\s*\\{[^}]*color:\\s*color-mix\\(in srgb,\\s*var\\(--primary\\)\\s*(\\d+)%,\\s*var\\(--muted-foreground\\)\\)`
			),
			`${cls} primary→muted-foreground color-mix`
		)
	}));
	// The ground: the block's top-of-gradient wash over --card.
	const washPct = pct(
		/\.here-now\s*\{[^}]*linear-gradient\(180deg,\s*color-mix\(in srgb,\s*var\(--primary\)\s*(\d+)%,\s*transparent\)/,
		'here-now primary wash color-mix'
	);

	for (const { name, sel } of THEME_BLOCKS) {
		it(`${name}: every tinted line meets 4.5:1 across the here-now gradient`, () => {
			const card = blockToken(sel, 'card');
			for (const { cls, pct: inkPct } of inkPcts) {
				const ink = mix2(blockToken(sel, 'primary'), inkPct, blockToken(sel, 'muted-foreground'));
				// Top of the block (full wash) and the end the gradient fades to.
				for (const ground of [mix2(blockToken(sel, 'primary'), washPct, card), card]) {
					expect(contrast(ink, ground), cls).toBeGreaterThanOrEqual(4.5);
				}
			}
		});
	}
});

// The con card's handle rows wash on hover. --secondary was the obvious fill and
// the wrong one: it is a surface token, and the muted handle value sitting on it
// was never checked against it. The wash is now a tint of the text colour over
// transparent, and the handle value goes full strength under the pointer (the
// SONA-124 chip precedent). Parse the real percentage and token out of the
// component, so a wash tweak re-runs the math and a revert to --muted-foreground
// text fails the pin.
describe('SONA-115 con card handle-row hover wash WCAG AA contrast', () => {
	const source = readFileSync(
		fileURLToPath(new URL('./components/ConCard.svelte', import.meta.url)),
		'utf8'
	);
	const washBody = source.match(/^\s*\.handles \.handle-row:hover\s*\{([^}]*)\}/m)?.[1];
	if (!washBody) throw new Error('.handles .handle-row:hover rule not found in ConCard.svelte');
	const washPct = Number(
		washBody.match(
			/background:\s*color-mix\(in srgb,\s*var\(--foreground\)\s*(\d+)%,\s*transparent\)/
		)?.[1]
	);
	const hoverBody = source.match(
		/^\s*\.handles \.handle-row:hover \.handle-value\s*\{([^}]*)\}/m
	)?.[1];
	const hoverToken = hoverBody?.match(/color:\s*var\(--([\w-]+)\)/)?.[1];

	it('washes with a foreground tint and lifts the handle value to --foreground', () => {
		if (!Number.isFinite(washPct)) throw new Error('the hover wash is no longer a foreground tint');
		expect(hoverToken).toBe('foreground');
	});

	// The resting pair is the one nobody was watching: --muted-foreground on the
	// bare surface clears AA by 0.03 on terracotta light, so a token nudge could
	// drop the handle values under it with every hover assertion still green.
	const restBody = source.match(/^\s*\.handle-value\s*\{([^}]*)\}/m)?.[1];
	const restToken = restBody?.match(/color:\s*var\(--([\w-]+)\)/)?.[1];

	for (const surface of ['background', 'card'] as const) {
		for (const { name, sel } of THEME_BLOCKS) {
			it(`${name}: resting row text meets 4.5:1 on the ${surface}`, () => {
				if (!restToken) throw new Error('the resting handle value sets no text color token');
				expect(
					contrast(blockToken(sel, restToken), blockToken(sel, surface))
				).toBeGreaterThanOrEqual(4.5);
			});
		}
	}

	for (const surface of ['background', 'card'] as const) {
		for (const { name, sel } of THEME_BLOCKS) {
			it(`${name}: hovered row text meets 4.5:1 on the wash over the ${surface}`, () => {
				if (!hoverToken) throw new Error('the hovered handle value sets no text color token');
				const washed = mix2(blockToken(sel, 'foreground'), washPct, blockToken(sel, surface));
				expect(contrast(blockToken(sel, hoverToken), washed)).toBeGreaterThanOrEqual(4.5);
			});
		}
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
		{ file: './components/VrViewer.svelte', selector: '.load-error' },
		// Same banner shape on the sticker-pack form. Its text is --foreground
		// today, so this row pins that rather than fixing anything (r4-06).
		{ file: './components/StickerPackForm.svelte', selector: '.banner.err' }
	];

	for (const { file, selector } of banners) {
		const { ink, pct: tintPct, label: textToken } = selfTint(ruleBody(file, selector), `${file} ${selector}`);

		it(`${file} ${selector} keeps the destructive tint and --foreground text`, () => {
			expect(ink, `${selector} lost its destructive tint`).toBe('destructive');
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

// The status chips and callouts paint their label in the SAME ink as their
// fill: color-mix(in srgb, var(--<ink>) N%, transparent) over whatever surface
// the chip sits on, with the label left at the raw token. That tint lifts the
// surface toward the ink, so the real ratio is the ink against the composite,
// not against the bare --background or --card that the resting sweep measures.
//
// --destructive is in the sweep too, not only the status inks: the
// observability page's .sbadge.red paints destructive-on-destructive-tint,
// which is the same self-tint shape and fails in nine theme × mode × surface
// combinations (recorded below). Its SOLID counterpart is a different pairing
// and lives in the destructive-button describe at the top of this file.
//
// Each row below is one RULE (file + selector), not a percentage: the tint
// percentage and the ink token are parsed out of the rule itself, so a retuned
// chip re-runs its own math instead of matching a hardcoded table.
//
// --status-attention is deliberately absent: nothing paints a tint of it (it is
// small text on a plain surface, covered by the SONA-162 describe below).
describe('status-ink text on its own tint (SONA-209)', () => {
	const TINTED_RULES: Array<{ file: string; selector: string }> = [
		{ file: './components/CloudflareSetupDialog.svelte', selector: '.scope' },
		{ file: './components/CloudflareSetupDialog.svelte', selector: '.callout' },
		{ file: '../routes/admin/vr/+page.svelte', selector: '.vis-chip.published' },
		{ file: '../routes/admin/vr/+page.svelte', selector: '.vis-chip.mature' },
		{ file: '../routes/admin/observability/+page.svelte', selector: '.en' },
		{ file: '../routes/admin/observability/+page.svelte', selector: '.sbadge.amber' },
		{ file: '../routes/admin/observability/+page.svelte', selector: '.sbadge.red' }
	];
	const SURFACES = ['background', 'card'] as const;

	// Read each rule once: the tint percentage, the token it mixes, and the token
	// the label is painted with. A rule that stops self-tinting (or stops being
	// found at all) throws here rather than dropping silently out of the sweep.
	const TINTS = TINTED_RULES.map(({ file, selector }) => ({
		file,
		selector,
		...selfTint(ruleBody(file, selector), `${file} ${selector}`)
	}));

	// Same bargain as KNOWN_FAILURES above: record the ratio measured when this
	// describe was written rather than silence the assert, because no palette
	// value moves in SONA-209. Terracotta light's status inks are the palest of
	// the three themes, and its page background is the lighter of the two
	// surfaces, so that is where a status ink and its tint converge. --destructive
	// is a saturated red in every palette and sits close to its own 20% tint on
	// most of them, which is why its failures are not confined to one theme.
	const TINT_KNOWN_FAILURES = new Map<string, number>([
		['terracotta light status-ok 14% on background', 4.43],
		['terracotta light status-ok 15% on background', 4.38],
		['terracotta light status-warn 15% on background', 4.34],
		['terracotta light status-warn 20% on background', 4.02],
		['ember dark destructive 20% on card', 4.31],
		['ember light destructive 20% on background', 3.79],
		['ember light destructive 20% on card', 4.19],
		['aurora dark destructive 20% on card', 4.47],
		['aurora light destructive 20% on background', 3.47],
		['aurora light destructive 20% on card', 3.73],
		['terracotta dark destructive 20% on background', 4.13],
		['terracotta dark destructive 20% on card', 3.72],
		['terracotta light destructive 20% on background', 3.57]
	]);

	for (const { file, selector, ink, pct, label } of TINTS) {
		it(`${file} ${selector} still paints --${ink} on its own ${pct}% tint`, () => {
			expect(
				label,
				`${file} ${selector} tints with --${ink} but labels with --${label} — the sweep below measures the self-tint pairing only`
			).toBe(ink);
		});
	}

	it('has no allowlist entry this sweep does not generate', () => {
		const generated = new Set(
			TINTS.flatMap(({ ink, pct }) =>
				SURFACES.flatMap((surface) =>
					THEME_BLOCKS.map(({ name }) => `${name} ${ink} ${pct}% on ${surface}`)
				)
			)
		);
		expect([...TINT_KNOWN_FAILURES.keys()].filter((k) => !generated.has(k))).toEqual([]);
	});

	// Two rules can share an ink and a percentage (the two 20% observability
	// badges do not, but a third could), so measure each distinct pairing once.
	const PAIRINGS = [...new Map(TINTS.map((t) => [`${t.ink} ${t.pct}`, t])).values()];

	for (const { ink, pct } of PAIRINGS) {
		for (const surface of SURFACES) {
			for (const { name, sel } of THEME_BLOCKS) {
				const key = `${name} ${ink} ${pct}% on ${surface}`;
				it(`${name}: --${ink} text meets 4.5:1 on its ${pct}% tint over the ${surface}`, () => {
					const hex = blockToken(sel, ink);
					const ratio = contrast(hex, mix2(hex, pct, blockToken(sel, surface)));
					const known = TINT_KNOWN_FAILURES.get(key);
					if (known !== undefined) {
						expect(
							ratio,
							`${key} now measures ${ratio.toFixed(2)}:1 and clears 4.5:1 — drop it from TINT_KNOWN_FAILURES`
						).toBeLessThan(4.5);
						expect(
							ratio,
							`${key} moved from the recorded ${known}:1 to ${ratio.toFixed(2)}:1 and still fails 4.5:1 — update its TINT_KNOWN_FAILURES ratio`
						).toBeCloseTo(known, 1);
						return;
					}
					expect(
						ratio,
						`${key} measures ${ratio.toFixed(2)}:1, under the 4.5:1 floor`
					).toBeGreaterThanOrEqual(4.5);
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
	// blockToken does the lazy resolution now: a block either declares a hex or
	// aliases/inherits its way to one, exactly as the cascade would.
	for (const surface of ['background', 'card'] as const) {
		for (const { name, sel } of THEME_BLOCKS) {
			it(`${name}: --status-attention text meets 4.5:1 on the ${surface} surface`, () => {
				expect(
					contrast(blockToken(sel, 'status-attention'), blockToken(sel, surface))
				).toBeGreaterThanOrEqual(4.5);
			});
		}
	}
});

// Prose links (the global `a` rule) color with --link, which tracks each
// theme's --primary like --status-attention but is overridden where the
// primary fails AA as small text: Ember light (--primary was 2.20:1 on the
// page background) and aurora dark (4.38:1) — SONA-171 r1-09/r1-18. The
// resolution below mirrors the CSS: a block either declares a hex or falls
// through (var(--primary)) to its own --primary. Every theme block must
// declare --link itself: the default light block's darkened orange otherwise
// bleeds into the other light themes through the plain [data-theme='light']
// selector they all carry.
describe('prose-link WCAG AA contrast, every theme × surface × mode (SONA-171)', () => {
	it('the global anchor rule colors with var(--link), not var(--primary)', () => {
		const rule = css.match(/^a\s*\{([^}]*)\}/m)?.[1];
		if (!rule) throw new Error('global a rule not found in app.css');
		expect(rule).toMatch(/color:\s*var\(--link\)\s*;/);
	});

	it('links get a visible keyboard-focus ring using var(--ring)', () => {
		const rule = css.match(/^a:focus-visible\s*\{([^}]*)\}/m)?.[1];
		if (!rule) throw new Error('a:focus-visible rule not found in app.css');
		expect(rule).toMatch(/outline:[^;]*var\(--ring\)/);
	});

	for (const { name, sel } of THEME_BLOCKS) {
		it(`${name}: declares link in its own token set`, () => {
			const { id, mode } = BLOCK_BY_SELECTOR.get(sel)!;
			const theme = ALL_THEMES.find((t) => t.id === id)!;
			expect(theme[mode].link, `${name} inherits --link instead of declaring it`).toBeDefined();
		});
	}

	for (const surface of ['background', 'card'] as const) {
		for (const { name, sel } of THEME_BLOCKS) {
			it(`${name}: link text meets 4.5:1 on the ${surface} surface`, () => {
				expect(contrast(blockToken(sel, 'link'), blockToken(sel, surface))).toBeGreaterThanOrEqual(4.5);
			});
		}
	}
});

// SONA-193: component-scoped anchor rules must color with var(--link), never
// raw var(--primary) — the token exists because --primary fails AA as link
// text in Ember light (2.20:1) and aurora dark (4.38:1), and a local rule
// bypasses the global fix in exactly the way the 13 rules this sweep repointed
// used to. Scans every component/route style block so a new offender fails
// here instead of shipping.
describe('no component anchor rule colors with --primary (SONA-193)', () => {
	const srcRoot = fileURLToPath(new URL('..', import.meta.url));
	const svelteFiles = readdirSync(srcRoot, { recursive: true })
		.map(String)
		.filter((p) => p.endsWith('.svelte'))
		.map((p) => `${srcRoot}/${p}`);
	// A selector targets an anchor when `a` appears as its own compound start
	// (" a", ".x a", "a.y", "a:hover", ":global(a)"), not as a substring of
	// another word.
	const anchorSelector = /(^|[\s.,>+~)(])a(\b|:|\.|\[)/;
	// Text color only, boundary-anchored: border-color/background-color on an
	// anchor are legitimate --primary uses (brand accents), not link text.
	const primaryTextColor = /(^|[;{\s])color:\s*var\(--primary\)/;

	it('scans a realistic file set', () => {
		expect(svelteFiles.length).toBeGreaterThan(50);
	});

	it('every anchor text color goes through var(--link)', () => {
		const offenders: string[] = [];
		for (const file of svelteFiles) {
			const source = readFileSync(file, 'utf8');
			for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
				if (!primaryTextColor.test(rule[2])) continue;
				// Every comma-separated selector in the list, not just the last
				// line: `.foo a,\n.bar` must flag on the `.foo a` part. Each
				// part's own last line drops any preceding-rule tail the loose
				// head match swept in.
				const parts = rule[1]
					.trim()
					.split(',')
					.map((part) => part.split('\n').pop()?.trim() ?? '')
					.filter(Boolean);
				for (const selector of new Set(parts)) {
					if (anchorSelector.test(selector)) {
						offenders.push(`${file.slice(srcRoot.length)} → ${selector}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});

// A native checkbox draws its checked fill with the UA's own accent, which every
// browser picks to clear the 3:1 non-text contrast bar (WCAG 1.4.11) against its
// own background. Overriding it with `accent-color: var(--primary)` would replace
// that with the site's terracotta, which measures 2.20:1 on Ember light — the
// same pairing SONA-193 repointed anchors away from. The checkbox has no text to
// carry the state, so a checked box that does not read as checked has no fallback.
//
// Nothing in the repo sets accent-color today. This pins that: the SONA-172
// settings rows were the first checkboxes anyone was tempted to style, and the
// tempting fix is exactly the one that fails.
describe('no accent-color override on form controls (SONA-172)', () => {
	const srcRoot = fileURLToPath(new URL('..', import.meta.url));
	const styled = readdirSync(srcRoot, { recursive: true })
		.map(String)
		.filter((p) => p.endsWith('.svelte') || p.endsWith('.css'))
		.map((p) => `${srcRoot}/${p}`);

	it('leaves the checked-checkbox fill to the user agent', () => {
		const offenders = styled.filter((file) => /(^|[;{\s])accent-color\s*:/.test(readFileSync(file, 'utf8')));
		expect(
			offenders.map((f) => f.slice(srcRoot.length)),
			'accent-color repaints a checked checkbox with the site accent. --primary measures 2.20:1 on Ember light, under the 3:1 non-text bar, and a checkbox has no label text to fall back on — that failure is why --ring exists. Leave the fill to the user agent.'
		).toEqual([]);
	});

	// The pointer floor and the describedby wiring are the other half of the
	// SONA-183 checkbox idiom, and a new row that copies the markup but not the
	// class loses both silently.
	it('gives every settings checkbox row the 24px title target and a described hint', () => {
		const src = readFileSync(
			new URL('../routes/admin/settings/+page.svelte', import.meta.url),
			'utf8'
		);
		const rows = [...src.matchAll(/<div class="checkbox-row">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
		expect(rows.length).toBeGreaterThanOrEqual(4);
		for (const row of rows) {
			const id = row.match(/id="([^"]+)"/)?.[1];
			expect(id, `a checkbox row has no id:\n${row}`).toBeTruthy();
			// The hint id has to be IN the description list, not necessarily be all
			// of it: a row may describe its control with a second element as well
			// (the RSS key-pending line does).
			const describedBy = row.match(/aria-describedby=(?:"[^"]*"|\{[^}]*\})/)?.[0];
			expect(describedBy, `a checkbox row has no aria-describedby:\n${row}`).toBeTruthy();
			if (describedBy?.startsWith('aria-describedby={')) {
				// A conditional list has to name the hint in EVERY arm. Searching the
				// expression as a whole would pass on a false arm that drops the hint,
				// which is the arm most readers land on.
				const arms = [...describedBy.matchAll(/'([^']*)'/g)].map((a) => a[1]);
				expect(arms.length, `a computed aria-describedby has no id literals:\n${row}`).toBeGreaterThan(0);
				for (const arm of arms) expect(arm.split(/\s+/), `arm omits the hint id:\n${row}`).toContain(`${id}-desc`);
			} else {
				expect(describedBy).toContain(`${id}-desc`);
			}
			expect(row).toMatch(new RegExp(`class="checkbox-title" for="${id}"`));
			expect(row).toContain(`id="${id}-desc"`);
		}
	});
});

// SONA-220: the tag chip and the suggest pill both hover. The pill's hovered
// LABEL is small text (4.5:1) and both hovered BORDERS are non-text boundaries
// (3:1), and raw --primary clears neither on a light card (2.32:1 as a label,
// 2.46:1 as a border) nor, as a label, on an aurora dark one (4.06:1). Both
// resolve through --link, the token that already exists for exactly this: it
// tracks --primary where it passes and darkens where it does not.
describe('SONA-220 tag chip and pill hover contrast, every theme × surface × mode', () => {
	// The --link the block actually computes (SONA-209): every theme × mode
	// declares the token, either as a hex of its own or as an alias onto its
	// --primary, and the cascade resolves both — which is what the old read of
	// the app.css palette block plus a --primary fallback was approximating.
	function linkColor(sel: string): string {
		return blockToken(sel, 'link');
	}

	it('colors the hovered pill label with var(--link)', () => {
		expect(blockBody('.tag-pill:hover')).toMatch(/color:\s*var\(--link\)\s*;/);
	});

	it('darkens the hovered chip and pill border to var(--link) in the light themes', () => {
		const rule = css.match(
			/^\[data-theme='light'\] \.tag-chip:not\(\.tag-chip-static\):hover,\n\[data-theme='light'\] \.tag-pill:hover\s*\{([^}]*)\}/m
		)?.[1];
		if (!rule) throw new Error('the light-theme tag hover border rule is missing from app.css');
		expect(rule).toMatch(/border-color:\s*var\(--link\)\s*;/);
	});

	// The disabled pill keeps its place in the tab order and reads out
	// "Suggesting tags…" while a lookup runs, so its label is text under the
	// 4.5:1 bar. It is color-mix(in srgb, var(--foreground) N%, var(--secondary))
	// over its own --secondary fill; parse N rather than pinning it.
	const disabledMix = (() => {
		const rule = blockBody(".tag-pill[aria-disabled='true']");
		const mix = rule.match(
			/color:\s*color-mix\(in srgb,\s*var\(--foreground\)\s*(\d+)%,\s*var\(--secondary\)\)/
		);
		if (!mix) throw new Error('the disabled pill label is no longer a foreground/secondary mix');
		return Number(mix[1]);
	})();

	for (const { name, sel } of THEME_BLOCKS) {
		it(`${name}: the disabled pill label meets 4.5:1 on its own fill`, () => {
			const fill = blockToken(sel, 'secondary');
			const label = mix2(blockToken(sel, 'foreground'), disabledMix, fill);
			expect(contrast(label, fill)).toBeGreaterThanOrEqual(4.5);
		});
	}

	// The backfill row's Save takes the same treatment when it refuses a click —
	// same mix on the same fill — so the loop above covers it too. Pinned here so
	// the two cannot drift into separate pairings unnoticed.
	it('the refused Save button reuses the disabled pill label mix on the same fill', () => {
		const rule = css.match(
			/^\.tag-btn-sm\[aria-disabled='true'\],\n\.tag-btn-sm\[aria-disabled='true'\]:hover\s*\{([^}]*)\}/m
		)?.[1];
		if (!rule) throw new Error('the refused Save button rule is missing from app.css');
		expect(rule).toMatch(/background-color:\s*var\(--secondary\)\s*;/);
		expect(rule).toMatch(
			new RegExp(
				`color:\\s*color-mix\\(in srgb,\\s*var\\(--foreground\\)\\s*${disabledMix}%,\\s*var\\(--secondary\\)\\)`
			)
		);
	});

	// And so does the row's Dismiss. A cursor and a hover that stops brightening
	// say nothing on a touch screen, so the three refused controls carry the same
	// fill and the same label mix — which puts Dismiss's label under the same
	// 4.5:1 bar the loop above measures.
	it('the refused Dismiss button reuses the disabled pill label mix on the same fill', () => {
		const rule = css.match(
			/^\.tag-btn-text\[aria-disabled='true'\],\n\.tag-btn-text\[aria-disabled='true'\]:hover\s*\{([^}]*)\}/m
		)?.[1];
		if (!rule) throw new Error('the refused Dismiss button rule is missing from app.css');
		expect(rule).toMatch(/background:\s*var\(--secondary\)\s*;/);
		expect(rule).toMatch(
			new RegExp(
				`color:\\s*color-mix\\(in srgb,\\s*var\\(--foreground\\)\\s*${disabledMix}%,\\s*var\\(--secondary\\)\\)`
			)
		);
	});

	// Stacked under a full-width Save, that shared fill would be a short pill
	// orphaned at the left edge, so the phone breakpoint widens it to the tray
	// instead of dropping it. Dropping it is what this test is here to stop: a
	// phone has no cursor and no hover, so the fill, the outline and the label
	// mix are the whole of the refused cue. The mix rides on --secondary, which
	// the disabled-pill loop above already floors at 4.5:1 in every theme.
	it('widens the refused Dismiss to the tray on a phone and keeps the shared fill', () => {
		const rule = css.match(
			/\.tag-actions \.tag-btn-text\[aria-disabled='true'\],\n\t\.tag-actions \.tag-btn-text\[aria-disabled='true'\]:hover\s*\{([^}]*)\}/
		)?.[1];
		if (!rule) throw new Error('the phone-width refused Dismiss rule is missing from app.css');
		expect(rule).toMatch(/width:\s*100%\s*;/);
		// Full width centres the label, which takes the resting padding on both
		// sides. A resting Dismiss keeps that padding too and is centred under the
		// primary by the stacked row itself, so no rule zeroes a pad on either.
		expect(css).toMatch(
			/@media \(max-width: 640px\) \{[^}]*\.tag-actions\s*\{\s*flex-direction:\s*column;\s*align-items:\s*center;/
		);
		expect(css).not.toMatch(/\.tag-actions \.tag-btn-text:not\(\[aria-disabled='true'\]\)/);
		expect(rule).not.toMatch(/padding/);
		// And nothing here may undo the inert treatment the base rule sets.
		expect(rule).not.toMatch(/background/);
		expect(rule).not.toMatch(/border/);
		expect(rule).not.toMatch(/color:/);
	});

	// A lone Dismiss drops its left pad on a wide screen to sit on the tray's
	// content edge. Stacked there is no edge to sit on, so the phone breakpoint
	// gives the pad back — and it has to be the pad the button rests at, or the
	// label lands off centre by the difference. Pinned to the base rule so the
	// two cannot drift apart.
	it('restores the resting left pad to a lone Dismiss on a phone', () => {
		const base = css.match(/^\.tag-btn-text\s*\{([^}]*)\}/m)?.[1];
		if (!base) throw new Error('the .tag-btn-text rest rule is missing from app.css');
		const resting = /padding:\s*[\d.]+px\s+([\d.]+px)\s*;/.exec(base)?.[1];
		if (!resting) throw new Error('the .tag-btn-text rest rule has no horizontal padding');
		const rule = css.match(/\.tag-actions \.tag-btn-text-flush\s*\{([^}]*)\}/)?.[1];
		if (!rule) throw new Error('the phone-width flush Dismiss rule is missing from app.css');
		expect(rule).toMatch(new RegExp(`padding-left:\\s*${resting.replace('.', '\\.')}\\s*;`));
	});

	// The refused state draws a real border. The rest rule reserves the same 1px
	// as a transparent one, so the border appearing mid-save does not widen
	// Dismiss and shove the row; the radius rides along so the visible border is
	// the capsule the buttons beside it wear.
	it('the resting Dismiss button reserves the refused border and its capsule', () => {
		const rule = css.match(/^\.tag-btn-text\s*\{([^}]*)\}/m)?.[1];
		if (!rule) throw new Error('the .tag-btn-text rest rule is missing from app.css');
		expect(rule).toMatch(/border:\s*1px solid transparent\s*;/);
		expect(rule).toMatch(/border-radius:\s*var\(--radius-pill\)\s*;/);
	});

	// A kept chip is a tint plus a check, and the check is the non-colour cue for
	// the state, so it is a meaningful graphic under the 3:1 bar. It sits on the
	// tint over the tray's --card, and takes --link in the light themes where raw
	// --primary is too pale on it. Aurora dark is the tightest pair at 3.49:1.
	const keptTint = (() => {
		const rule = blockBody(".tag-chip[aria-pressed='true']");
		const mix = rule.match(
			/background:\s*color-mix\(in srgb,\s*var\(--primary\)\s*(\d+)%,\s*transparent\)/
		);
		if (!mix) throw new Error('the kept chip fill is no longer a primary tint');
		return Number(mix[1]);
	})();

	it('draws the kept chip check in --primary, and in --link in the light themes', () => {
		expect(blockBody(".tag-chip[aria-pressed='true'] svg")).toMatch(/color:\s*var\(--primary\)\s*;/);
		expect(blockBody("[data-theme='light'] .tag-chip[aria-pressed='true'] svg")).toMatch(
			/color:\s*var\(--link\)\s*;/
		);
	});

	for (const { name, sel } of THEME_BLOCKS) {
		it(`${name}: the kept chip's check meets 3:1 on the chip tint`, () => {
			const card = blockToken(sel, 'card');
			const tint = mix2(blockToken(sel, 'primary'), keptTint, card);
			const icon = name.endsWith('light') ? linkColor(sel) : blockToken(sel, 'primary');
			expect(contrast(icon, tint)).toBeGreaterThanOrEqual(3);
		});
	}

	for (const surface of ['background', 'card'] as const) {
		for (const { name, sel } of THEME_BLOCKS) {
			const border = name.endsWith('light') ? linkColor : (s: string) => blockToken(s, 'primary');

			it(`${name}: the hovered pill label meets 4.5:1 on the ${surface} surface`, () => {
				expect(contrast(linkColor(sel), blockToken(sel, surface))).toBeGreaterThanOrEqual(4.5);
			});

			it(`${name}: the hovered chip and pill border meets 3:1 on the ${surface} surface`, () => {
				expect(contrast(border(sel), blockToken(sel, surface))).toBeGreaterThanOrEqual(3);
			});
		}
	}
});

// SONA-220: the saved and refused backfill rows put one action beside a row of
// static saved-tag chips wearing the same capsule. The action's border is what
// separates them, so it is a control boundary held to 3:1 on the card it sits
// on — the chips' resting --border is nowhere near that, which is the point.
describe('SONA-220 saved-row action border contrast, every theme × mode', () => {
	// color-mix(in srgb, var(--foreground) N%, var(--card)); parse N rather than
	// pinning it, so a later tweak is measured instead of failing on the number.
	const actionMix = (() => {
		const mix = blockBody('.tag-pill-action').match(
			/border-color:\s*color-mix\(in srgb,\s*var\(--foreground\)\s*(\d+)%,\s*var\(--card\)\)/
		);
		if (!mix) throw new Error('the saved-row action border is no longer a foreground/card mix');
		return Number(mix[1]);
	})();

	for (const { name, sel } of THEME_BLOCKS) {
		it(`${name}: the action border meets 3:1 on the card it sits on`, () => {
			const card = blockToken(sel, 'card');
			expect(contrast(mix2(blockToken(sel, 'foreground'), actionMix, card), card)).toBeGreaterThanOrEqual(3);
		});

		it(`${name}: it is a clear step up from the static chip border beside it`, () => {
			const card = blockToken(sel, 'card');
			const chip = contrast(blockToken(sel, 'border'), card);
			const action = contrast(mix2(blockToken(sel, 'foreground'), actionMix, card), card);
			expect(action).toBeGreaterThan(chip * 1.5);
		});
	}
});

// The Artist lookup "Remove key" button rides .btn-outline but overrides its
// label to --destructive. .btn-outline's hover fill mixes --background 88%
// toward white or black, and --destructive on that mix falls to 3.6-4.4:1 on
// five of the six themes, so the component pins the fill back to --background
// and lets the border carry the hover signal (SONA-156). Asserted the way the
// #103 hover tests are: resolve the rule's own fill in each theme block and
// measure the label against it, so any fill that clears AA passes and any that
// doesn't fails, whatever it is spelled as.
describe('SONA-156 Remove-key label on its hover fill', () => {
	/** The body of a `.lookup-section .btn-remove` rule, as written. */
	function removeRule(suffix: string): string {
		const source = readFileSync(
			fileURLToPath(new URL('../routes/admin/settings/+page.svelte', import.meta.url)),
			'utf8'
		);
		const body = source.match(
			new RegExp(`^\\s*\\.lookup-section \\.btn-remove${suffix}\\s*\\{([^}]*)\\}`, 'm')
		)?.[1];
		if (!body) throw new Error(`.lookup-section .btn-remove${suffix} rule not found`);
		return body;
	}

	/** The `background-color` the hovered button actually paints, as written. */
	function removeHoverFill(): string {
		const fill = removeRule(':hover')
			.match(/background-color:\s*([^;]+);/)?.[1]
			.trim();
		// No fill of its own means the button inherits .btn-outline's hover mix,
		// which is the pairing this block exists to keep it away from.
		if (!fill) throw new Error('.lookup-section .btn-remove:hover sets no background-color');
		return fill;
	}

	/**
	 * The label color the hovered button paints. The hover rule may set its own
	 * `color`; when it doesn't, the base rule's `color` still applies, so the
	 * measurement follows whichever one the button actually wears.
	 */
	function removeHoverColor(): string {
		const declared = (body: string) =>
			body
				.match(/(?:^|[;{\s])color:\s*([^;]+);/)?.[1]
				.trim();
		const color = declared(removeRule(':hover')) ?? declared(removeRule(''));
		if (!color) throw new Error('.lookup-section .btn-remove declares no color');
		return color;
	}

	// A token, or a srgb color-mix of one toward black, white or another token —
	// the two shapes the app's hover fills and labels use. Anything else throws
	// rather than passing unmeasured.
	function resolveColor(value: string, sel: string): string {
		const token = value.match(/^var\(--([\w-]+)\)$/);
		if (token) return blockToken(sel, token[1]);
		const mixed = value.match(
			/^color-mix\(in srgb,\s*var\(--([\w-]+)\)\s*(\d+)%,\s*(black|white|var\(--[\w-]+\))\)$/
		);
		if (!mixed) throw new Error(`cannot resolve "${value}" to a color`);
		const base = blockToken(sel, mixed[1]);
		const pct = Number(mixed[2]);
		const toward = mixed[3];
		if (toward === 'black' || toward === 'white') return mixSrgb(base, pct, toward);
		return mix2(base, pct, blockToken(sel, toward.slice('var(--'.length, -1)));
	}

	for (const { name, sel } of THEME_BLOCKS) {
		it(`${name}: the label on the hovered fill meets 4.5:1`, () => {
			const fill = resolveColor(removeHoverFill(), sel);
			const label = resolveColor(removeHoverColor(), sel);
			expect(contrast(label, fill)).toBeGreaterThanOrEqual(4.5);
		});
	}
});

// SONA-126: --primary-text is the token --primary becomes when it has to be read
// rather than looked at. The sweep above already measures it against --background
// and --card for every theme × mode; this pins the LIGHT blocks specifically,
// because light is where raw --primary fails (Ember light is 2.20:1) and where a
// future palette tweak would break it first. It also pins that the value is a
// concrete hex rather than an alias that silently resolves to the dark block's.
describe('light --primary-text is readable as small text (SONA-126)', () => {
	for (const theme of ALL_THEMES) {
		it(`${theme.id} light: --primary-text clears 4.5:1 on --background and --card`, () => {
			const ink = themeHex(theme.id, 'light', 'primaryText');
			for (const ground of ['background', 'card'] as const) {
				const ratio = contrast(ink, themeHex(theme.id, 'light', ground));
				expect(
					ratio,
					`${theme.id} light: --primary-text (${ink}) on --${ground} measures ${ratio.toFixed(2)}:1`
				).toBeGreaterThanOrEqual(4.5);
			}
		});
	}

	// Every block that declares --primary declares --primary-text next to it. A
	// block that sets one and not the other inherits a text colour tuned for a
	// different palette — the source-order trap the --link comments describe.
	it('every block that declares --primary declares --primary-text', () => {
		const missing = ALL_THEMES.flatMap((theme) =>
			(['dark', 'light'] as const)
				.filter((mode) => theme[mode].primary !== undefined && theme[mode].primaryText === undefined)
				.map((mode) => `${theme.id} ${mode}`)
		);
		expect(missing).toEqual([]);
	});
});

// SONA-126 follow-up: the Telegram pack chip paints 13px text on a tint of
// --primary over --background, which is neither of the two surfaces the sweep
// measures. --primary-text landed between 3.75:1 and 4.08:1 there on three of the
// six pairs; --foreground clears 4.5:1 on all six. The tint is read out of the
// rule rather than assumed, so a change to the percentage is measured.
describe('the Telegram pack chip is readable on its tint (SONA-126)', () => {
	const CHIP = '../routes/(public)/stickers/[slug]/+page.svelte';
	const body = ruleBody(CHIP, '.pack-chip.telegram');
	const tint = body.match(
		/background:\s*color-mix\(in srgb,\s*var\(--([\w-]+)\)\s*(\d+)%,\s*var\(--([\w-]+)\)\)/
	);
	// Lookbehind so `background-color:` and `border-color:` are not read as the ink.
	const ink = body.match(/(?<![-\w])color:\s*var\(--([\w-]+)\)/)?.[1];

	it('still tints its background and names an ink token', () => {
		expect(tint, '.pack-chip.telegram no longer mixes its background').not.toBeNull();
		expect(ink, '.pack-chip.telegram declares no color').toBeDefined();
	});

	for (const { name, id, mode } of THEME_BLOCKS) {
		it(`${name}: the chip label clears 4.5:1`, () => {
			const [, base, pct, over] = tint!;
			const ground = mix2(
				themeHex(id, mode, TOKEN_BY_CSS_NAME.get(base)!),
				Number(pct),
				themeHex(id, mode, TOKEN_BY_CSS_NAME.get(over)!)
			);
			const ratio = contrast(themeHex(id, mode, TOKEN_BY_CSS_NAME.get(ink!)!), ground);
			expect(
				ratio,
				`${name}: --${ink} on the chip tint (${ground}) measures ${ratio.toFixed(2)}:1`
			).toBeGreaterThanOrEqual(4.5);
		});
	}
});

// SONA-126: `color: var(--primary)` on a TEXT selector is the bug --primary-text
// fixes — on Ember light it paints 14px labels at 2.20:1. The sweep moved every
// text use over; what is left is --primary drawing something that is not read as
// text, and each of those is named here with why. A new `color: var(--primary)`
// fails this test until it is either repointed at --primary-text or added below
// with a reason.
describe('no text rule paints with raw --primary (SONA-126)', () => {
	const srcRoot = fileURLToPath(new URL('..', import.meta.url));

	// file → the rules that keep raw --primary, and why. Every entry is an icon:
	// icons carry no text, so WCAG's 4.5:1 small-text bar does not apply to them.
	// Where the icon is a state cue (a pressed chip's check glyph), 1.4.11 asks
	// for 3:1 on the cue, and the glyph alone does not meet it on Ember light;
	// each of those states also carries a border and a background tint, so the
	// state is not read from the glyph alone. Repainting the glyphs is 1.4.11
	// polish left for the theme work in SONA-209.
	// The list is counted, not just matched — a file may keep exactly as many raw
	// --primary colour rules as it has reasons here, so a NEW one in a listed file
	// fails this test the same way a new one anywhere else does.
	const ALLOWED = new Map<string, string[]>([
		['/app.css', ["tag-chip[aria-pressed='true'] svg — the chip's check glyph, not its label"]],
		[
			'/lib/components/Callout.svelte',
			['.primary .icon — the callout glyph; .primary .title is the text and uses --primary-text']
		],
		[
			'/lib/components/SetupDialog.svelte',
			['.modal-sub :global(svg) — the subtitle glyph, next to --muted-foreground text']
		],
		[
			'/lib/components/RefSheetPicker.svelte',
			[
				'.modal-sub :global(svg) — the same subtitle glyph as SetupDialog',
				'.slot-chip :global(svg) — the check glyph on a selected slot chip',
				'.suggestion :global(svg) — the same check glyph on a suggestion'
			]
		],
		[
			'/lib/components/LinkRow.svelte',
			['.badge — a 36px tinted disc holding one icon and no text']
		],
		[
			'/lib/components/CopyCommand.svelte',
			['.copy.copied — the copy button is an icon; its state is announced, not read']
		],
		[
			'/routes/(paths)/art/+page.svelte',
			['.featured-label :global(svg) — the star glyph beside the label']
		],
		[
			'/routes/(paths)/+layout.svelte',
			['.hero .hero-icon — the hero glyph, sized well past the small-text bar']
		],
		[
			'/routes/(public)/+page@.svelte',
			[
				'.card:hover :global(.chevron) — the hover affordance glyph',
				'.badge — a 44px tinted tile holding one icon and no text'
			]
		],
		[
			'/routes/(public)/stickers/[slug]/[id]/+page.svelte',
			['.pack-link-arrow — the arrow glyph after the link, which uses --primary-text']
		]
	]);

	const styled = readdirSync(srcRoot, { recursive: true })
		.map(String)
		.filter((p) => p.endsWith('.svelte') || p.endsWith('.css'))
		.map((p) => `/${p}`);

	// `color:` only — `background-color:` and `border-color:` end in the same
	// characters, and both are legitimate --primary uses. The trailing `[,)]`
	// catches the fallback spelling, `var(--primary, var(--foreground))`, which is
	// the same colour on every theme that declares one.
	const RAW = /(?:^|[;{\s])color:\s*var\(--primary[,)]/g;
	const rawCount = (file: string) => (readFileSync(`${srcRoot}${file}`, 'utf8').match(RAW) ?? []).length;

	it('has no allowlist entry for a file that no longer uses raw --primary', () => {
		const stale = [...ALLOWED.keys()].filter((f) => !styled.includes(f) || rawCount(f) === 0);
		expect(stale, 'these files stopped using raw --primary — drop them from ALLOWED').toEqual([]);
	});

	it('allows exactly as many raw --primary rules per file as it has reasons', () => {
		const drifted = [...ALLOWED]
			.filter(([file, reasons]) => styled.includes(file) && rawCount(file) !== reasons.length)
			.map(([file, reasons]) => `${file}: ${rawCount(file)} rules, ${reasons.length} reasons`);
		expect(
			drifted,
			'a raw `color: var(--primary)` rule was added to or removed from an allowlisted file — repoint it at --primary-text, or list it above with the reason it is not text.'
		).toEqual([]);
	});

	it('paints text with --primary-text everywhere else', () => {
		const offenders = styled.filter((f) => !ALLOWED.has(f) && rawCount(f) > 0);
		expect(
			offenders,
			'`color: var(--primary)` measures 2.20:1 on Ember light. Use var(--primary-text) for text, or add the rule to ALLOWED above with the reason it is not text.'
		).toEqual([]);
	});
});

// SONA-126 raised --input to 3:1 on both surfaces so the two CONTROL boundaries
// clear WCAG 1.4.11, and pointed .btn-outline at it. The sweep above measures
// the token; this pins the rules that use it, because a rule quietly moved back
// to --border would pass every contrast assertion and still leave the control
// edge at ~1.4:1.
describe('control boundaries use --input, not --border (SONA-126)', () => {
	const rules = {
		'.btn-outline': "the outline button's 1px edge is the only thing marking it as a control",
		'.input': 'the form-field boundary'
	};

	for (const [selector, why] of Object.entries(rules)) {
		it(`${selector} draws its border with --input`, () => {
			const border = blockBody(selector).match(/border:\s*1px solid var\(--([\w-]+)\)/)?.[1];
			expect(border, `${selector} declares no 1px solid border`).toBeDefined();
			expect(border, `${why} — --border is the decorative hairline and sits near 1.4:1`).toBe(
				'input'
			);
		});
	}

	// The hover shifts the SAME boundary, so it has to start from the same token.
	// Mixing from --border while the resting edge draws with --input makes the
	// button's outline jump palette on hover, and the shift stops being the small
	// nudge #103 asked for.
	it('.btn-outline:hover shifts the border it actually has', () => {
		expect(hoverBorderMix('.btn-outline:hover').base).toBe('input');
	});

	// The same segmented control is hand-written in three routes. When only one of
	// them carried the boundary, the outline appeared and disappeared as a visitor
	// clicked between the tabs of one switch, so every copy is pinned here
	// along with the view toggle that sits in the gallery's filter row.
	const componentRules: Array<{ file: string; selector: string }> = [
		{ file: '../routes/(public)/gallery/+page.svelte', selector: '.tabs' },
		{ file: '../routes/(public)/gallery/+page.svelte', selector: '.view-toggle' },
		{ file: '../routes/(public)/stickers/+page.svelte', selector: '.tabs' },
		{ file: '../routes/(public)/vr/+page.svelte', selector: '.tabs' }
	];

	for (const { file, selector } of componentRules) {
		it(`${file} ${selector} draws its border with --input`, () => {
			expect(ruleBody(file, selector)).toMatch(/border:\s*1px solid var\(--input\)/);
		});
	}

	// The selected platform chip is the same kind of boundary, drawn with
	// border-color rather than the border shorthand because the resting rule
	// already sets the width and style. It marked selection with raw --primary,
	// which is 2.46:1 against --card on Ember light; --primary-text is 4.57:1 at
	// its worst (terracotta dark) across the six theme × mode pairs.
	it('the selected platform chip draws its edge with --primary-text', () => {
		const body = ruleBody('./components/VrAvatarForm.svelte', '.platform-chip.on');
		const border = body.match(/border-color:\s*var\(--([\w-]+)\)/)?.[1];
		expect(border, '.platform-chip.on declares no border-color').toBeDefined();
		expect(border).toBe('primary-text');
	});

	for (const { name, id, mode } of THEME_BLOCKS) {
		it(`${name}: the selected chip's edge clears 3:1 on --card`, () => {
			const ratio = contrast(themeHex(id, mode, 'primaryText'), themeHex(id, mode, 'card'));
			expect(ratio, `${name}: --primary-text on --card measures ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
		});
	}

	// The admin header's avatar disc is a solid fill, not a boundary, but it is the
	// other place this change swapped a token: on light themes it paints with
	// --primary-text so the disc and the header's primary text are one orange
	// rather than two.
	it('the light-theme admin avatar disc fills with --primary-text', () => {
		expect(
			ruleBody('../routes/admin/+layout.svelte', ":global([data-theme='light']) .admin-avatar")
		).toMatch(/background:\s*var\(--primary-text\)/);
	});
});
