// Theme registry. Each entry is a palette family applied at SSR via a
// `data-theme-id` attribute on <html>; the actual CSS custom-property values
// live in src/app.css under `[data-theme-id='<id>']` (and its [data-theme='light']
// variant). The dark/light *mode* is orthogonal to the theme. To add a theme:
// add an entry here AND the matching token blocks in app.css.

export interface ThemeOption {
	id: string;
	label: string;
}

export const THEMES: ThemeOption[] = [
	{ id: 'default', label: 'Ember — warm orange (default)' },
	{ id: 'aurora', label: 'Aurora — cool violet' },
	{ id: 'terracotta', label: 'Terracotta — warm clay' }
];

export const DEFAULT_THEME_ID = 'default';

export function isValidThemeId(id: string): boolean {
	return THEMES.some((t) => t.id === id);
}
