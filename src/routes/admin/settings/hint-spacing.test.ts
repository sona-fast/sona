import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pin for the settings hints, per the cover-picker-square precedent.
// A `.hint` paragraph belongs to the field above it, and it is also what breaks
// the `label + label` rule that gives stacked fields their 20px of air: with a
// <p> between them the next label matches no adjacent-sibling selector and gets
// no top margin at all. So the hint's own bottom margin is the only gap between
// a hint and the field under it, and a revert to `margin: 8px 0 0` puts the next
// label flush against text that describes a different field.

const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('settings hint spacing', () => {
	const hintRule = (pageSrc.match(/^\t\.hint \{[\s\S]*?\}/m)?.[0] ?? '').replace(
		/\/\*[\s\S]*?\*\//g,
		''
	);

	it('finds the rule', () => {
		expect(hintRule).toContain('font-size: 12px');
	});

	it('leaves the same 20px the label-to-label rule gives two stacked fields', () => {
		const margin = hintRule.match(/margin:\s*\d+px\s+0\s+(\d+)px/);
		expect(margin, `.hint no longer sets a three-value margin: ${hintRule}`).not.toBeNull();
		expect(Number(margin![1])).toBe(20);
	});

	it('still relies on the label-to-label rule for fields with no hint between them', () => {
		expect(pageSrc).toContain('section > :is(label, .checkbox-row) + :is(label, .checkbox-row)');
	});
});
