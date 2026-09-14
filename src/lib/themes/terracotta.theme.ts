import type { ThemeDefinition, PartialThemeTokens } from './types.ts';

// Terracotta — warm clay (akito.dog's brand palette, upstreamed). Also carries
// akito's typography; the font tokens are emitted in the dark block and apply to
// the light variant too, since [data-theme-id='terracotta'] matches in both
// modes. Tokens it does not declare fall through to the default theme.

const dark: PartialThemeTokens = {
	background: '#1E1E1E',
	foreground: '#EADED6',
	card: '#282624',
	cardForeground: '#EADED6',
	// Lightened terracotta: akito's brand #DD5131 was 4.20:1 on the dark
	// background and 3.80:1 on cards — below WCAG AA (4.5:1) for small text.
	// #E2694D (same hue/saturation, minimally lighter) clears AA on both the
	// background (5.05:1) and cards (4.57:1); the near-black foreground on it
	// is 5.05:1.
	primary: '#E2694D',
	primaryForeground: '#1E1E1E',
	secondary: '#3A3633',
	secondaryForeground: '#EADED6',
	muted: '#3A3633',
	mutedForeground: '#B5A99E',
	accent: '#1E1E1E',
	accentForeground: '#EADED6',
	destructive: '#FF5C33',
	// The light foreground (#EADED6) was 2.33:1 on the destructive fill — the
	// near-black foreground clears AA at 5.42:1, mirroring the primary button.
	destructiveForeground: '#1E1E1E',
	// This theme's primary already clears AA as link text (5.05:1 on the
	// background, 4.57:1 on cards).
	link: { ref: 'primary' },
	border: '#3A3633',
	input: '#3A3633',
	ring: '#E2694D',
	sidebar: '#181716',
	sidebarAccent: '#2A2724',
	sidebarForeground: '#EADED6',
	sidebarBorder: 'rgba(255, 255, 255, 0.1)'
};

const light: PartialThemeTokens = {
	background: '#EADED6',
	foreground: '#1E1E1E',
	card: '#FFFFFF',
	cardForeground: '#1E1E1E',
	// Darkened terracotta: #DD5131 was 3.0:1 on the light background — below
	// WCAG AA (4.5:1) for small text. #AD3A1E clears AA on both the page
	// background (4.68:1) and white cards (6.18:1); the light foreground on it
	// is 4.68:1.
	primary: '#AD3A1E',
	primaryForeground: '#EADED6',
	secondary: '#DDD0C6',
	secondaryForeground: '#1E1E1E',
	muted: '#E0D4CA',
	mutedForeground: '#6B6259',
	accent: '#EADED6',
	accentForeground: '#1E1E1E',
	// Darkened destructive: #D93C15 was 3.66:1 under the near-black foreground
	// on the button fill and 3.45:1 as error text on the page background.
	// #B23008 clears AA in every role it plays: 4.80:1 as text on the page
	// background, 6.33:1 on white cards, and 4.80:1 under the light foreground
	// on the button fill.
	destructive: '#B23008',
	destructiveForeground: '#EADED6',
	// statusOk/statusWarn inherit the family-neutral light values; only re-point
	// attention to this theme's primary (#AD3A1E is 6.2:1 on white).
	statusAttention: { ref: 'primary' },
	// Back to this theme's primary (4.68:1 on the background, 6.17:1 on cards).
	// Same source-order tie as aurora light: without this line the terracotta
	// DARK block's value would win here (it resolves to var(--primary), which
	// lands on the right color — but only by luck, so declare it explicitly).
	link: { ref: 'primary' },
	border: '#CBBEB3',
	input: '#CBBEB3',
	ring: '#AD3A1E',
	sidebar: '#DDD0C6',
	sidebarAccent: '#CBBEB3',
	sidebarForeground: '#1E1E1E',
	sidebarBorder: '#CBBEB3'
};

export const terracottaTheme: ThemeDefinition = {
	id: 'terracotta',
	label: 'Terracotta — warm clay',
	dark,
	light,
	fonts: {
		primary: "'Chakra Petch', sans-serif",
		secondary: "'IBM Plex Sans JP', sans-serif"
	}
};
