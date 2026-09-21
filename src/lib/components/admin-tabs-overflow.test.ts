import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The phone-width admin tab strip hides its scrollbar, so without an edge fade
// nothing says there are more tabs past either edge. The fades and the padding
// that keeps the first and last tab off the edges live inside the same media
// query as the scroll, and re-enabling the scrollbar is not the fix we want.

const src = readFileSync(new URL('./AdminTabs.svelte', import.meta.url), 'utf8');

describe('AdminTabs overflow affordance', () => {
	const rule = (src.match(/^\t\t\.admin-tabs \{[\s\S]*?\}/m)?.[0] ?? '').replace(
		/\/\*[\s\S]*?\*\//g,
		''
	);

	it('finds the scrolling rule inside the phone media query', () => {
		expect(rule).toContain('overflow-x: auto');
		expect(rule).toContain('scrollbar-width: none');
	});

	it('fades both edges, with the prefixed property for older WebKit', () => {
		for (const prop of [/[^-]mask-image:([^;]*)/, /-webkit-mask-image:([^;]*)/]) {
			const value = rule.match(prop)?.[1] ?? '';
			expect(value, 'the strip no longer masks with a left-to-right gradient').toMatch(
				/linear-gradient\(to right,/
			);
			expect(value, 'the strip no longer fades at its start edge').toMatch(
				/transparent 0,\s*#000 \d+px/
			);
			expect(value, 'the strip no longer fades at its end edge').toMatch(
				/#000 calc\(100% - \d+px\),\s*transparent 100%\)/
			);
		}
	});

	it('pads both edges by the same distance the fades cover', () => {
		const fadeEnd = rule.match(/[^-]mask-image:[^;]*calc\(100% - (\d+)px\)/)?.[1];
		const fadeStart = rule.match(/[^-]mask-image:[^;]*transparent 0,\s*#000 (\d+)px/)?.[1];
		// padding: 0 <right> 12px <left>
		const pad = rule.match(/padding:\s*(?:0|\d+px)\s+(\d+)px\s+(?:0|\d+px)\s+(\d+)px/);
		expect(fadeEnd, 'the fade no longer ends a fixed distance from the right edge').toBeDefined();
		expect(fadeStart, 'the fade no longer starts a fixed distance from the left edge').toBe(
			fadeEnd
		);
		expect(pad, 'the strip no longer sets a four-value padding').not.toBeNull();
		expect(pad![1], 'the right padding no longer matches the fade').toBe(fadeEnd);
		expect(pad![2], 'the left padding no longer matches the fade').toBe(fadeStart);
	});

	it('keeps a focused tab out from under either fade', () => {
		expect(rule).toMatch(/scroll-padding-inline-end:\s*24px/);
		expect(rule).toMatch(/scroll-padding-inline-start:\s*24px/);
	});

	it('does not bring the scrollbar back', () => {
		expect(src).toMatch(/\.admin-tabs::-webkit-scrollbar \{\s*display: none;/);
	});
});

// The settings sub-tab strip is the same affordance one level down, so it fades
// and pads the same way. It lives in the settings page rather than a component,
// which is why it is read out of that file here.
describe('settings sub-tab strip overflow affordance', () => {
	const settings = readFileSync(
		new URL('../../routes/admin/settings/+page.svelte', import.meta.url),
		'utf8'
	);
	const rule = (settings.match(/^\t\t\.settings-tabnav \{[\s\S]*?\}/m)?.[0] ?? '').replace(
		/\/\*[\s\S]*?\*\//g,
		''
	);

	it('fades both edges by the same distance it pads them', () => {
		const fadeEnd = rule.match(/[^-]mask-image:[^;]*calc\(100% - (\d+)px\)/)?.[1];
		const fadeStart = rule.match(/[^-]mask-image:[^;]*transparent 0,\s*#000 (\d+)px/)?.[1];
		expect(fadeEnd, 'the sub-tab strip no longer fades at its end edge').toBeDefined();
		expect(fadeStart, 'the sub-tab strip no longer fades at its start edge').toBe(fadeEnd);
		expect(rule.match(/padding-right:\s*(\d+)px/)?.[1]).toBe(fadeEnd);
		expect(rule.match(/padding-left:\s*(\d+)px/)?.[1]).toBe(fadeStart);
	});

	it('keeps a focused sub-tab out from under either fade', () => {
		expect(rule).toMatch(/scroll-padding-inline-end:\s*24px/);
		expect(rule).toMatch(/scroll-padding-inline-start:\s*24px/);
	});
});

// Both admin navs mark the page you are on for assistive tech, not just with a
// fill: the tab strip on phones and the sidebar on wider viewports. Each sets
// aria-current from the same expression that sets its .active class, so the
// marker cannot drift away from the highlight. The Playwright side of this,
// which checks the rendered page carries exactly one of each, is in
// tests/e2e/settings-tabs.spec.ts.
describe('the admin navs mark the current page for assistive tech', () => {
	const layout = readFileSync(
		new URL('../../routes/admin/+layout.svelte', import.meta.url),
		'utf8'
	);

	// `class:active={EXPR}` and `aria-current={EXPR ? 'page' : undefined}` on the
	// same element, with EXPR captured so the two can be compared.
	function activeMarkers(source: string, where: string) {
		const active = source.match(/class:active=\{([^}]+)\}/)?.[1];
		const current = source.match(/aria-current=\{([^}]+)\s*\?\s*'page'\s*:\s*undefined\}/)?.[1];
		if (!active) throw new Error(`${where} no longer sets class:active`);
		return { active: active.trim(), current: current?.trim() };
	}

	for (const [where, source] of [
		['AdminTabs.svelte', src],
		['routes/admin/+layout.svelte', layout]
	] as const) {
		it(`${where} sets aria-current from the same expression as .active`, () => {
			const { active, current } = activeMarkers(source, where);
			expect(current, `${where} no longer sets aria-current="page" on the active link`).toBe(
				active
			);
		});
	}
});
