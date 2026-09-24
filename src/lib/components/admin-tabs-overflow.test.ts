import { describe, it, expect } from 'vitest';
import { lstatSync, readFileSync } from 'node:fs';

// The phone-width admin tab strip hides its scrollbar, so without an edge fade
// nothing says there are more tabs past either edge. The fades and the padding
// that keeps the first and last tab off the edges live inside the same media
// query as the scroll, and re-enabling the scrollbar is not the fix we want.

/** Reads a source file this test pins, refusing a symlink or a non-file. */
function readSource(url: URL): string {
	const stat = lstatSync(url);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(`${url.pathname} is not a regular file`);
	}
	return readFileSync(url, 'utf8');
}

const src = readSource(new URL('./AdminTabs.svelte', import.meta.url));

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
	const settings = readSource(new URL('../../routes/admin/settings/+page.svelte', import.meta.url));
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
