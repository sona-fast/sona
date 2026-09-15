import { describe, it, expect } from 'vitest';
import { blockChain, resolveToken } from './cascade.ts';
import { ALL_THEMES } from './all.ts';
import type { PartialThemeTokens, ThemeDefinition } from './types.ts';

// Identity, not deep equality: two blocks that happen to hold the same tokens
// would let a wrong chain pass a value comparison.
function expectChain(actual: PartialThemeTokens[], expected: PartialThemeTokens[]): void {
	expect(actual).toHaveLength(expected.length);
	expected.forEach((block, i) => expect(actual[i]).toBe(block));
}

// blockChain is the precedence rule the generator's emission order and every
// contrast measurement both rest on, and until here only its callers covered it.
// Identity comparisons rather than value ones: the point is WHICH block objects
// match, in what order — two themes that happened to share a hex would hide a
// wrong chain.
describe('blockChain', () => {
	const base = ALL_THEMES[0];
	const aurora = ALL_THEMES.find((t) => t.id === 'aurora')!;

	it('puts an alternate light block over its own dark block, then the default pair', () => {
		expectChain(blockChain(ALL_THEMES, 'aurora', 'light'), [
			aurora.light,
			aurora.dark,
			base.light,
			base.dark
		]);
	});

	it('falls an alternate dark block through to the default dark block', () => {
		expectChain(blockChain(ALL_THEMES, 'aurora', 'dark'), [aurora.dark, base.dark]);
	});

	it('reads the default light block over the default dark block', () => {
		expectChain(blockChain(ALL_THEMES, base.id, 'light'), [base.light, base.dark]);
	});

	it('reads the default dark block alone — it is the floor', () => {
		expectChain(blockChain(ALL_THEMES, base.id, 'dark'), [base.dark]);
	});

	it('throws on a theme id that is not in the list', () => {
		expect(() => blockChain(ALL_THEMES, 'nope', 'dark')).toThrow(/unknown theme id: nope/);
	});
});

// The precedence that surprises people: on an alternate theme's LIGHT mode, the
// theme's own dark block outranks the default light block, because both the
// alternate dark selector and [data-theme='light'] tie on specificity and the
// alternate is emitted later. A fixture rather than the real palettes, so this
// asserts the rule and not a hex someone may retune.
describe('resolveToken precedence', () => {
	const fixture: ThemeDefinition[] = [
		{
			id: 'default',
			label: 'Fixture default',
			dark: { link: '#111111' },
			light: { link: '#222222' }
		},
		{
			id: 'alt',
			label: 'Fixture alt',
			// No --link in the light set: it must NOT inherit the default light
			// block's value, because alt's own dark block wins there.
			dark: { link: '#333333' },
			light: {}
		}
	];

	it("takes the alternate theme's dark value over the default light one", () => {
		expect(resolveToken(fixture, 'alt', 'light', 'link')).toBe('#333333');
	});
});
