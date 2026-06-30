import { getContext, setContext } from 'svelte';
import { THEME_STORAGE_KEY } from '$lib/config';

const THEME_KEY = 'theme';

export type Theme = 'dark' | 'light';

export function createThemeState() {
	let theme = $state<Theme>('dark');

	// Load from localStorage on init
	if (typeof window !== 'undefined') {
		const saved = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
		if (saved) theme = saved;
	}

	function toggle() {
		theme = theme === 'dark' ? 'light' : 'dark';
		if (typeof window !== 'undefined') {
			localStorage.setItem(THEME_STORAGE_KEY, theme);
		}
	}

	const state = {
		get current() { return theme; },
		toggle
	};

	setContext(THEME_KEY, state);
	return state;
}

export function getTheme() {
	return getContext<ReturnType<typeof createThemeState>>(THEME_KEY);
}
