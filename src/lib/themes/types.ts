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
	// --primary as SMALL TEXT (headings, labels, eyebrows, counts, chip text).
	// --primary itself is a fill and a border first, and on a light page it is far
	// too light to read as 14px text (Ember light is 2.20:1). Every block that
	// declares --primary declares this one too: dark blocks point it back at
	// --primary, light blocks carry a darkened value that clears 4.5:1 on both
	// --background and --card (SONA-126).
	primaryText: '--primary-text',
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

/**
 * One `@font-face` block. The fonts are SELF-HOSTED (SONA-181): the files live
 * in static/fonts/ and are fetched by `node scripts/fetch-fonts.mjs`, so no page
 * contacts Google's font CDN.
 */
export interface FontFace {
	/** The family name the font-family lists refer to, unquoted. */
	family: string;
	/** A single weight (400) or a variable-font range ('100 900'). */
	weight: number | string;
	/** Defaults to 'normal'. */
	style?: string;
	/** Path under /fonts/, e.g. '/fonts/JetBrainsMono-400-latin.woff2'. */
	src: string;
	/** The subset this file covers. Without it the browser downloads every slice. */
	unicodeRange?: string;
}

/**
 * The unicode-range strings Google's CSS2 API emits for its named subsets. They
 * are identical across every family we self-host, so they are named once here
 * rather than repeated in every face.
 */
export const SUBSET_LATIN =
	'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
export const SUBSET_LATIN_EXT =
	'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';
export const SUBSET_VIETNAMESE =
	'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB';

export interface ThemeFonts {
	/** CSS font-family list for --font-primary (headings, UI chrome). */
	primary: string;
	/** CSS font-family list for --font-secondary (body copy). */
	secondary: string;
	/**
	 * The self-hosted files behind those families. The generator emits every
	 * theme's faces at the top of generated.css — @font-face is top-level, it
	 * cannot be nested inside a theme's selector — but a browser downloads a file
	 * only when something on the page actually renders in that family, and
	 * --font-primary/--font-secondary name these families only inside the theme's
	 * own block. So an unselected theme's fonts cost a parsed rule and no bytes.
	 */
	faces?: FontFace[];
}

export interface ThemeDefinition {
	id: string;
	label: string;
	dark: PartialThemeTokens;
	light: PartialThemeTokens;
	/** Set only by themes that carry their own typography (terracotta and petal do). */
	fonts?: ThemeFonts;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
// Channels are 0-255, not any three digits: rgba(999, 0, 0, 0.5) is invalid CSS
// and the browser drops the whole declaration. Leading zeros are legal CSS, so
// `007` is a padded 7 rather than a fourth digit.
const CHANNEL = '(?:0*(?:25[0-5]|2[0-4]\\d|1?\\d?\\d))';
const RGBA = new RegExp(
	`^rgba\\(\\s*${CHANNEL}\\s*,\\s*${CHANNEL}\\s*,\\s*${CHANNEL}\\s*,\\s*(?:0|1|0?\\.\\d+|1\\.0+)\\s*\\)$`
);

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
		// hasOwnProperty, not `in`: `in` also finds Object.prototype members, so an
		// alias to 'toString' or 'constructor' would pass the guard and emit
		// var(undefined).
		if (!Object.prototype.hasOwnProperty.call(TOKEN_CSS_NAMES, value.ref)) {
			throw new Error(`${key}: alias to unknown token '${value.ref}'`);
		}
		return `var(${cssName(value.ref)})`;
	}
	if (HEX.test(value) || RGBA.test(value)) return value;
	throw new Error(
		`${key}: '${value}' is not a 6-digit hex, an rgba() string with channels in 0-255, or an alias`
	);
}
