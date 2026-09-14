// Theme data model. A theme is a palette family: a dark token set, a light
// token set, and optionally its own fonts. `scripts/build-themes.ts` turns
// these definitions into src/lib/themes/generated.css, and
// src/lib/theme-contrast.test.ts asserts WCAG contrast over the same data, so
// the palette has exactly one source of truth.
//
// A token value is one of three forms:
//   • a six-digit hex string  ('#FF8400')          → emitted verbatim
//   • an alias  ({ ref: 'primary' })               → emitted as var(--primary)
//   • an rgba() string  ('rgba(255, 255, 255, 0.1)') — sidebarBorder only today
// Aliases are not resolved at build time on purpose: `--link: var(--primary)`
// resolves per element against whatever --primary the cascade landed on, and
// several blocks depend on that (see the aurora/terracotta light comments).
//
// INHERITANCE RULE — a per-mode token set is PARTIAL, and a token a block does
// not declare is not a token with a default: it is a token that block leaves to
// the cascade. Aurora light, for example, declares no --status-ok, so the value
// comes from [data-theme='light'] at runtime. Never "complete" a block with the
// values it currently inherits: that adds declarations, which changes which
// block wins for a reader of the generated CSS and can flip a source-order tie.
// Add a token to a block only when today's app.css declared it there.
//
// The default theme is the exception: it declares every token in both modes
// (`:root` and `[data-theme='light']` are the floor everything else falls back
// to), so its two sets are typed as the complete ThemeTokens.

/**
 * Every colour token a theme can set, mapped to its CSS custom property.
 * KEY ORDER IS THE EMISSION ORDER: the generator walks these keys in order, so
 * moving a key here moves the declaration in generated.css.
 */
export const TOKEN_CSS_NAMES = {
	background: '--background',
	foreground: '--foreground',
	card: '--card',
	cardForeground: '--card-foreground',
	primary: '--primary',
	primaryForeground: '--primary-foreground',
	secondary: '--secondary',
	secondaryForeground: '--secondary-foreground',
	muted: '--muted',
	mutedForeground: '--muted-foreground',
	accent: '--accent',
	accentForeground: '--accent-foreground',
	destructive: '--destructive',
	destructiveForeground: '--destructive-foreground',
	statusOk: '--status-ok',
	statusWarn: '--status-warn',
	statusAttention: '--status-attention',
	link: '--link',
	border: '--border',
	input: '--input',
	ring: '--ring',
	sidebar: '--sidebar',
	sidebarAccent: '--sidebar-accent',
	sidebarForeground: '--sidebar-foreground',
	sidebarBorder: '--sidebar-border'
} as const;

export type TokenKey = keyof typeof TOKEN_CSS_NAMES;

/** `var(--<ref>)` — resolved by the cascade at use time, not at build time. */
export interface TokenAlias {
	ref: TokenKey;
}

export type TokenValue = string | TokenAlias;

/** A complete token set. Only the default theme is required to be complete. */
export type ThemeTokens = { [K in TokenKey]: TokenValue };

/** What an alternate theme declares: whatever it does not inherit. */
export type PartialThemeTokens = Partial<ThemeTokens>;

export interface ThemeFonts {
	/** CSS font-family list for --font-primary (headings, UI chrome). */
	primary: string;
	/** CSS font-family list for --font-secondary (body copy). */
	secondary: string;
}

export interface ThemeDefinition {
	id: string;
	label: string;
	dark: PartialThemeTokens;
	light: PartialThemeTokens;
	/** Set only by themes that carry their own typography (terracotta does). */
	fonts?: ThemeFonts;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
const RGBA = /^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\)$/;

export function isAlias(value: TokenValue): value is TokenAlias {
	return typeof value === 'object' && value !== null && 'ref' in value;
}

/** The CSS custom-property name for a token key (`cardForeground` → `--card-foreground`). */
export function cssName(key: TokenKey): string {
	return TOKEN_CSS_NAMES[key];
}

/**
 * The CSS value a token emits. Throws on anything that is not one of the three
 * accepted forms, so a typo lands as a build failure rather than an invalid
 * declaration browsers silently drop.
 */
export function cssValue(key: TokenKey, value: TokenValue): string {
	if (isAlias(value)) {
		if (!(value.ref in TOKEN_CSS_NAMES)) throw new Error(`${key}: alias to unknown token '${value.ref}'`);
		return `var(${cssName(value.ref)})`;
	}
	if (HEX.test(value) || RGBA.test(value)) return value;
	throw new Error(`${key}: '${value}' is not a 6-digit hex, an rgba() string, or an alias`);
}
