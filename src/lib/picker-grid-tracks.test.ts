import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pin for the picker grids' TRACK sizing, following the
// cover-picker-square.test.ts precedent.
//
// Why this can't be an e2e test: the bug only appears in stock Firefox. Both
// Chromium and Playwright's bundled (patched) Firefox render these grids
// correctly with 1fr columns, so a browser assertion in CI would pass with the
// fix reverted — it was verified by hand against Firefox 153.
//
// The bug: with `repeat(auto-fill, minmax(N, 1fr))` columns, a cell's height
// comes only from its `aspect-ratio` (derived from the resolved column width).
// Firefox does not feed that derived height back into row track sizing, so the
// rows get sized from content — ~17px for a lazy image — while each cell paints
// at its ~77px derived height. Every cell then overflows its row and is
// overlapped by the row below, leaving a sliver of each image. Layout APIs
// report the correct 77px the whole time (reading them forces the reflow that
// fixes it), which is why this is pinned in the source rather than measured.
//
// The fix is fixed tracks on BOTH axes, so no track size depends on
// aspect-ratio resolving. Reverting either axis brings the bug back.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const GRIDS = [
	{
		name: 'VR poster picker',
		src: read('./components/VrAvatarForm.svelte'),
		selector: '.poster-grid',
		size: '72px'
	},
	{
		name: 'collections cover picker',
		src: read('../routes/admin/collections/+page.svelte'),
		selector: '.cover-grid',
		size: '64px'
	}
];

describe('picker grids size their tracks explicitly', () => {
	for (const { name, src, selector, size } of GRIDS) {
		// The rule body, minus comments — the comments describe the old 1fr shape.
		const rule = (src.match(new RegExp(`\\${selector} \\{[\\s\\S]*?\\}`))?.[0] ?? '').replace(
			/\/\*[\s\S]*?\*\//g,
			''
		);

		it(`${name}: columns are a fixed ${size}, not 1fr`, () => {
			expect(rule).toContain(`repeat(auto-fill, ${size})`);
			// The exact regression: 1fr columns make the cell height aspect-derived.
			expect(rule).not.toMatch(/minmax\([^)]*1fr\)/);
		});

		it(`${name}: rows are a fixed ${size}, not content-sized`, () => {
			expect(rule).toMatch(new RegExp(`grid-auto-rows:\\s*${size}`));
		});

		it(`${name}: keeps the row filled without 1fr`, () => {
			// Fixed columns leave slack at the row's end; this is what absorbs it.
			expect(rule).toMatch(/justify-content:\s*space-between/);
		});
	}
});
