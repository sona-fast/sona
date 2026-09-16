import type { ThemeDefinition, PartialThemeTokens } from './types.ts';

// Pewter — quiet slate. Inherits the default typography; the palette is the only
// thing it changes. Tokens it does not declare fall through to the default theme
// at runtime (see the inheritance rule in types.ts); do not fill them in.

const dark: PartialThemeTokens = {
	background: '#141618',
	foreground: '#E6E8EA',
	card: '#1C1F22',
	cardForeground: '#E6E8EA',
	primary: '#7FA6CC',
	primaryForeground: '#141618',
	// primary already clears AA as small text here (7.11:1 on the background,
	// 6.49:1 on cards), so the text token is the same colour.
	primaryText: { ref: 'primary' },
	secondary: '#2A2F34',
	secondaryForeground: '#E6E8EA',
	muted: '#2A2F34',
	mutedForeground: '#A3ABB3',
	accent: '#141618',
	accentForeground: '#E6E8EA',
	destructive: '#F17E74',
	// The light foreground on this fill is 2.14:1; the near-black page colour
	// clears AA at 6.89:1, mirroring the primary button.
	destructiveForeground: '#141618',
	statusOk: '#98C5A0',
	statusWarn: '#DEB684',
	// primary is light enough to read on both dark surfaces, so attention and
	// links point straight at it.
	statusAttention: { ref: 'primary' },
	link: { ref: 'primary' },
	border: '#2A2F34',
	// 3.44:1 on the page background, 3.14:1 on cards (WCAG 1.4.11).
	input: '#636D77',
	ring: '#5C81A6',
	sidebar: '#17191C',
	sidebarAccent: '#2A2F34',
	sidebarForeground: '#E6E8EA',
	sidebarBorder: 'rgba(255, 255, 255, 0.1)'
};

const light: PartialThemeTokens = {
	background: '#EFF1F3',
	foreground: '#1B1F23',
	card: '#FFFFFF',
	cardForeground: '#1B1F23',
	// A deeper slate blue than the dark mode's: that one is 2.25:1 on this
	// background, below AA for a label and too pale under white button text.
	primary: '#3A5B7B',
	primaryForeground: '#FFFFFF',
	// This theme's light primary is dark enough to read as small text (6.26:1 on
	// the background, 7.09:1 on cards). Declared here rather than inherited for
	// the same source-order reason as --link below.
	primaryText: { ref: 'primary' },
	secondary: '#C4CDD5',
	secondaryForeground: '#1B1F23',
	muted: '#D4DDE5',
	mutedForeground: '#4A545E',
	accent: '#EFF1F3',
	accentForeground: '#1B1F23',
	destructive: '#A8241C',
	destructiveForeground: '#FFFFFF',
	statusOk: '#376040',
	statusWarn: '#785424',
	// Attention points at this theme's primary (6.26:1 on the background).
	statusAttention: { ref: 'primary' },
	// Back to this theme's primary (6.26:1 on the background, 7.09:1 on cards).
	// Same source-order tie as aurora light: without this line the pewter DARK
	// block's value would win here, at 2.25:1 on this light background.
	link: { ref: 'primary' },
	border: '#C8CED4',
	// 3.46:1 on the page background, 3.92:1 on cards.
	input: '#77828C',
	ring: '#6184A6',
	sidebar: '#E1E5E9',
	sidebarAccent: '#C8CED4',
	sidebarForeground: '#1B1F23',
	sidebarBorder: '#C8CED4'
};

export const pewterTheme: ThemeDefinition = {
	id: 'pewter',
	label: 'Pewter — quiet slate',
	dark,
	light
};
