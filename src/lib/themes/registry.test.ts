import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { THEMES, DEFAULT_THEME_ID } from './index.ts';
import { ALL_THEMES } from './all.ts';

// index.ts carries the picker list as a plain literal so the admin bundles do
// not pull in every palette (see the comment there). That only works while the
// literal and the data agree, which is what these asserts are for.

describe('the theme registry', () => {
	it('lists the same ids and labels as the theme data, in the same order', () => {
		expect(THEMES).toEqual(ALL_THEMES.map(({ id, label }) => ({ id, label })));
	});

	// Emission order is load-bearing: the default theme's blocks are the :root
	// floor every other theme falls back to, so it has to be first.
	it('puts the default theme first', () => {
		expect(ALL_THEMES[0].id).toBe(DEFAULT_THEME_ID);
	});

	// A theme file nobody listed is invisible: no CSS block, no contrast sweep,
	// and no picker entry — it just silently does not exist.
	it('lists every *.theme.ts file in this directory, and no others', () => {
		const dir = fileURLToPath(new URL('.', import.meta.url));
		const files = readdirSync(dir)
			.filter((f) => f.endsWith('.theme.ts'))
			.map((f) => f.replace(/\.theme\.ts$/, ''))
			.sort();
		expect(files).toEqual(ALL_THEMES.map((t) => t.id).sort());
	});
});
