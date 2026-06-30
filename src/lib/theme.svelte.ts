import { getContext, setContext } from 'svelte';
import { THEME_MODE_COOKIE } from '$lib/config';

const THEME_KEY = 'theme';

export type Theme = 'dark' | 'light';

// The dark/light MODE. The server sets the initial `data-theme` on <html> from
// the THEME_MODE_COOKIE (see hooks.server.ts), so first paint is already correct.
// The client store seeds itself from that attribute (no flip on hydrate) and the
// toggle updates the attribute + cookie live.
function initialMode(): Theme {
	if (typeof document !== 'undefined') {
		const attr = document.documentElement.getAttribute('data-theme');
		if (attr === 'light' || attr === 'dark') return attr;
	}
	return 'dark';
}

export function createThemeState() {
	let theme = $state<Theme>(initialMode());

	function toggle() {
		theme = theme === 'dark' ? 'light' : 'dark';
		if (typeof document !== 'undefined') {
			document.documentElement.setAttribute('data-theme', theme);
			// 1 year; lax so it travels on normal navigations.
			document.cookie = `${THEME_MODE_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
		}
	}

	const state = {
		get current() {
			return theme;
		},
		toggle
	};

	setContext(THEME_KEY, state);
	return state;
}

export function getTheme() {
	return getContext<ReturnType<typeof createThemeState>>(THEME_KEY);
}
