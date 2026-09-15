import type { ThemeDefinition, PartialThemeTokens } from './types.ts';

// Aurora — cool violet. Tokens it does not declare fall through to the default
// theme at runtime (see the inheritance rule in types.ts); do not fill them in.

const dark: PartialThemeTokens = {
	background: '#0e0f1a',
	foreground: '#f4f4ff',
	card: '#16172a',
	cardForeground: '#f4f4ff',
	primary: '#7c5cff',
	// Near-black button label; darkened from the page bg (#0e0f1a) so the resting
	// label-on-fill clears WCAG AA (4.60:1 vs 4.39 before; hover stays 5.60).
	primaryForeground: '#07080d',
	secondary: '#232544',
	secondaryForeground: '#f4f4ff',
	muted: '#232544',
	mutedForeground: '#a9abce',
	accent: '#0e0f1a',
	accentForeground: '#f4f4ff',
	destructive: '#ff5c7a',
	destructiveForeground: '#0e0f1a',
	// primary is too light on this dark card for AA text (4.06:1). Status
	// attention gets a lighter violet that clears 4.5:1 on card and background.
	statusAttention: '#a48bff',
	// primary is 4.38:1 on this dark background — below AA for link text.
	// The same lighter violet: 7.00:1 on the background, 6.48:1 on cards.
	link: '#a48bff',
	border: '#2a2c50',
	input: '#2a2c50',
	ring: '#7c5cff',
	sidebar: '#131426',
	sidebarAccent: '#232544',
	sidebarForeground: '#f4f4ff',
	sidebarBorder: 'rgba(255, 255, 255, 0.1)'
};

const light: PartialThemeTokens = {
	background: '#f5f5fc',
	foreground: '#16172a',
	card: '#ffffff',
	cardForeground: '#16172a',
	primary: '#6a4cf0',
	primaryForeground: '#ffffff',
	secondary: '#ececfa',
	secondaryForeground: '#16172a',
	muted: '#f0f0fb',
	mutedForeground: '#5b5d80',
	accent: '#f5f5fc',
	accentForeground: '#16172a',
	destructive: '#d1284c',
	destructiveForeground: '#ffffff',
	// statusOk/statusWarn inherit the family-neutral light values; only re-point
	// attention to this theme's primary (#6a4cf0 is 5.4:1 on white).
	statusAttention: { ref: 'primary' },
	// Back to this theme's primary (4.96:1 on the background, 5.38:1 on cards).
	// Load-bearing: [data-theme='light'] and [data-theme-id='aurora'] tie on
	// specificity and the aurora DARK block comes later in source order, so
	// without this line its #a48bff wins here — 2.51:1 on this light background.
	link: { ref: 'primary' },
	border: '#d8d8ee',
	input: '#d8d8ee',
	ring: '#6a4cf0',
	sidebar: '#ececfa',
	sidebarAccent: '#d8d8ee',
	sidebarForeground: '#16172a',
	sidebarBorder: '#d8d8ee'
};

export const auroraTheme: ThemeDefinition = {
	id: 'aurora',
	label: 'Aurora — cool violet',
	dark,
	light
};
