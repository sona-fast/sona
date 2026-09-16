import { SUBSET_LATIN, SUBSET_LATIN_EXT, type ThemeDefinition, type ThemeTokens } from './types.ts';

// Ember — warm orange. The default theme, and the floor every other theme falls
// back to: it emits `:root` and `[data-theme='light']`, so both sets are
// COMPLETE (see the inheritance rule in types.ts).

const dark: ThemeTokens = {
	background: '#111111',
	foreground: '#FFFFFF',
	card: '#1A1A1A',
	cardForeground: '#FFFFFF',
	primary: '#FF8400',
	primaryForeground: '#111111',
	// primary reads fine as small text on this dark page (7.69:1) and on cards
	// (7.09:1), so the text token is the same colour.
	primaryText: { ref: 'primary' },
	secondary: '#2E2E2E',
	secondaryForeground: '#FFFFFF',
	muted: '#2E2E2E',
	mutedForeground: '#B8B9B6',
	accent: '#111111',
	accentForeground: '#F2F3F0',
	destructive: '#FF5C33',
	destructiveForeground: '#111111',
	// Status colours for the observability dashboard, themed like destructive so
	// they clear WCAG AA (4.5:1 text) on the card in BOTH modes. On dark cards the
	// bright mock values pass; the light-mode values below darken them for the
	// white card. statusAttention tracks each theme's primary (resolved lazily per
	// element), overridden only where the light primary would be too light.
	statusOk: '#4ade80',
	statusWarn: '#f5a623',
	statusAttention: { ref: 'primary' },
	// Prose-link text colour (SONA-171 r1-09/r1-18). Tracks each theme's primary
	// like statusAttention, overridden only where the primary fails WCAG AA
	// (4.5:1) as small text on background or card. Guarded by
	// theme-contrast.test.ts for every theme × surface × mode.
	link: { ref: 'primary' },
	border: '#2E2E2E',
	// The form-field and outline-button boundary, raised to clear WCAG 1.4.11's
	// 3:1 on BOTH surfaces a control sits on (3.49:1 on the page, 3.22:1 on
	// cards). --border stays the soft hairline it was (SONA-126).
	input: '#6A6A6A',
	ring: '#666666',
	sidebar: '#18181b',
	sidebarAccent: '#2a2a30',
	sidebarForeground: '#fafafa',
	sidebarBorder: 'rgba(255, 255, 255, 0.1)'
};

const light: ThemeTokens = {
	background: '#F2F3F0',
	foreground: '#111111',
	card: '#FFFFFF',
	cardForeground: '#111111',
	primary: '#FF8400',
	primaryForeground: '#111111',
	// primary (#FF8400) is 2.20:1 on this light background — unreadable as small
	// text. The same darkened orange --link uses: 5.26:1 on the page background,
	// 5.86:1 on cards.
	primaryText: '#A04E00',
	secondary: '#E7E8E5',
	secondaryForeground: '#111111',
	muted: '#F2F3F0',
	mutedForeground: '#666666',
	accent: '#F2F3F0',
	accentForeground: '#111111',
	// #BE320E is 5.16:1 on the #F2F3F0 page background; the mock #D93C15 was 4.09:1
	// and failed AA as field-error text. Darkening only raises white-on-fill
	// contrast for the destructive button, so the fill uses stay safe.
	destructive: '#BE320E',
	destructiveForeground: '#FFFFFF',
	// Darkened for the white card (the mock values fail on white): #166534 is
	// 7.1:1 on white and 6.2:1 on the 14% tint the badges use; #92400E is 7.1:1 /
	// 6.3:1; #C2410C is 5.2:1. These are family-neutral (green is green, amber is
	// amber) — the alternate light themes reuse them and only re-point attention.
	statusOk: '#166534',
	statusWarn: '#92400E',
	statusAttention: '#C2410C',
	// primary (#FF8400) is 2.20:1 on this light background — far below AA for
	// link text. Darkened orange: 5.26:1 on the page background, 5.86:1 on cards.
	link: '#A04E00',
	border: '#CBCCC9',
	// 3.84:1 on the page background, 4.28:1 on cards.
	input: '#797B76',
	ring: '#666666',
	sidebar: '#E7E8E5',
	sidebarAccent: '#CBCCC9',
	sidebarForeground: '#18181b',
	sidebarBorder: '#CBCCC9'
};

export const defaultTheme: ThemeDefinition = {
	id: 'default',
	label: 'Ember — warm orange (default)',
	dark,
	light,
	fonts: {
		primary: "'JetBrains Mono', monospace",
		secondary: "'Geist', sans-serif",
		// Geist is NOT here: its three faces are hand-written in app.css and always
		// apply, because this theme is the fallback floor for every other one.
		// JetBrains Mono is fetched by `node scripts/fetch-fonts.mjs`. Google serves
		// it as ONE variable file per subset covering every weight, so each subset is
		// declared once over the 400-700 range rather than four times over the same
		// bytes.
		faces: [
			{ family: 'JetBrains Mono', weight: '400 700', src: '/fonts/JetBrainsMono-latin.woff2', unicodeRange: SUBSET_LATIN },
			{ family: 'JetBrains Mono', weight: '400 700', src: '/fonts/JetBrainsMono-latin-ext.woff2', unicodeRange: SUBSET_LATIN_EXT }
		]
	}
};
