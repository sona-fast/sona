import {
	SUBSET_LATIN,
	SUBSET_LATIN_EXT,
	SUBSET_VIETNAMESE,
	type ThemeDefinition,
	type PartialThemeTokens
} from './types.ts';

// Petal — soft pink. Carries its own headline face (Nunito) over the default
// body font; the font tokens are emitted in the dark block and apply to the
// light variant too, since [data-theme-id='petal'] matches in both modes.
// Tokens it does not declare fall through to the default theme at runtime (see
// the inheritance rule in types.ts); do not fill them in.

const dark: PartialThemeTokens = {
	background: '#1B1418',
	foreground: '#F7EEF2',
	card: '#251B21',
	cardForeground: '#F7EEF2',
	primary: '#F5A3BE',
	primaryForeground: '#1B1418',
	// primary already clears AA as small text here (9.37:1 on the background,
	// 8.64:1 on cards), so the text token is the same colour.
	primaryText: { ref: 'primary' },
	secondary: '#372A31',
	secondaryForeground: '#F7EEF2',
	muted: '#372A31',
	mutedForeground: '#C2AFB8',
	accent: '#1B1418',
	accentForeground: '#F7EEF2',
	destructive: '#FF7663',
	// The light foreground on this fill is 2.30:1; the near-black page colour
	// clears AA at 6.92:1, mirroring the primary button.
	destructiveForeground: '#1B1418',
	statusOk: '#7CCD8E',
	statusWarn: '#F1AF57',
	// primary is light enough to read on both dark surfaces, so attention and
	// links point straight at it.
	statusAttention: { ref: 'primary' },
	link: { ref: 'primary' },
	border: '#372A31',
	// 3.39:1 on the page background, 3.12:1 on cards (WCAG 1.4.11).
	input: '#76676C',
	ring: '#CC7E99',
	sidebar: '#201720',
	sidebarAccent: '#372A31',
	sidebarForeground: '#F7EEF2',
	sidebarBorder: 'rgba(255, 255, 255, 0.1)'
};

const light: PartialThemeTokens = {
	background: '#FBF3F6',
	foreground: '#221820',
	card: '#FFFFFF',
	cardForeground: '#221820',
	// A deep rose rather than the dark mode's blossom pink: the light pink is
	// 1.77:1 on this background and unreadable as a label or a button fill.
	primary: '#993359',
	primaryForeground: '#FFFFFF',
	// This theme's light primary is dark enough to read as small text (6.48:1 on
	// the background, 7.07:1 on cards). Declared here rather than inherited for
	// the same source-order reason as --link below.
	primaryText: { ref: 'primary' },
	secondary: '#D6C9CC',
	secondaryForeground: '#221820',
	muted: '#E6D9DC',
	mutedForeground: '#615255',
	accent: '#FBF3F6',
	accentForeground: '#221820',
	destructive: '#AC281B',
	destructiveForeground: '#FFFFFF',
	statusOk: '#09672E',
	statusWarn: '#805307',
	// Attention points at this theme's primary (6.48:1 on the background).
	statusAttention: { ref: 'primary' },
	// Back to this theme's primary (6.48:1 on the background, 7.07:1 on cards).
	// Same source-order tie as aurora light: without this line the petal DARK
	// block's value would win here, and its blossom pink is 1.77:1 on this
	// background.
	link: { ref: 'primary' },
	border: '#E4CFD9',
	// 3.64:1 on the page background, 3.97:1 on cards.
	input: '#8A7C82',
	ring: '#C85E81',
	sidebar: '#F2E2E9',
	sidebarAccent: '#E4CFD9',
	sidebarForeground: '#221820',
	sidebarBorder: '#E4CFD9'
};

export const petalTheme: ThemeDefinition = {
	id: 'petal',
	label: 'Petal — soft pink',
	dark,
	light,
	fonts: {
		primary: "'Nunito', sans-serif",
		secondary: "'Geist', sans-serif",
		// Geist is the default body face and app.css already declares it, so only
		// Nunito is listed here.
		//
		// Self-hosted: the slices come from `node scripts/fetch-fonts.mjs` —
		// static/fonts/README.md says why. Google serves Nunito as one variable
		// file per subset covering every weight, the way it serves JetBrains Mono,
		// so each face is declared once over the 400-700 range.
		faces: [
			{ family: 'Nunito', weight: '400 700', src: '/fonts/Nunito-latin.woff2', unicodeRange: SUBSET_LATIN },
			{ family: 'Nunito', weight: '400 700', src: '/fonts/Nunito-latin-ext.woff2', unicodeRange: SUBSET_LATIN_EXT },
			{ family: 'Nunito', weight: '400 700', src: '/fonts/Nunito-vietnamese.woff2', unicodeRange: SUBSET_VIETNAMESE }
		]
	}
};
