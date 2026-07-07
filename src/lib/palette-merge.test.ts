import { describe, it, expect } from 'vitest';
import { mergeSuggestions, paletteHas, dedupePalette } from './palette-merge';

describe('mergeSuggestions', () => {
	it('returns every suggestion when none are in the palette yet', () => {
		expect(mergeSuggestions(['#111111'], ['#AABBCC', '#DDEEFF'])).toEqual(['#AABBCC', '#DDEEFF']);
	});

	it('skips hexes already in the palette, comparing case-insensitively', () => {
		expect(mergeSuggestions(['#aabbcc', '#DDEEFF'], ['#AABBCC', '#ddeeff', '#123456'])).toEqual([
			'#123456'
		]);
	});

	it('dedupes within the suggestions themselves', () => {
		expect(mergeSuggestions([], ['#AABBCC', '#aabbcc', '#AABBCC', '#DDEEFF'])).toEqual([
			'#AABBCC',
			'#DDEEFF'
		]);
	});

	it('handles empty inputs', () => {
		expect(mergeSuggestions([], [])).toEqual([]);
		expect(mergeSuggestions(['#AABBCC'], [])).toEqual([]);
		expect(mergeSuggestions([], ['#AABBCC'])).toEqual(['#AABBCC']);
	});

	it('caps the additions at the remaining capacity', () => {
		expect(mergeSuggestions([], ['#111111', '#222222', '#333333'], 2)).toEqual([
			'#111111',
			'#222222'
		]);
		expect(mergeSuggestions(['#111111'], ['#111111', '#222222', '#333333'], 0)).toEqual([]);
		// The limit counts only fresh additions, not skipped duplicates.
		expect(mergeSuggestions(['#111111'], ['#111111', '#222222', '#333333'], 1)).toEqual([
			'#222222'
		]);
	});
});

describe('paletteHas', () => {
	it('matches case-insensitively', () => {
		expect(paletteHas(['#AABBCC'], '#aabbcc')).toBe(true);
		expect(paletteHas(['#aabbcc'], '#AABBCC')).toBe(true);
	});

	it('is false when the hex is absent or the palette is empty', () => {
		expect(paletteHas(['#AABBCC'], '#123456')).toBe(false);
		expect(paletteHas([], '#AABBCC')).toBe(false);
	});
});

describe('dedupePalette', () => {
	it('drops duplicate hexes case-insensitively, keeping the first occurrence', () => {
		expect(
			dedupePalette([
				{ name: 'Plum', hex: '#9A5363' },
				{ name: 'Orange', hex: '#F5A572' },
				{ name: 'Plum again', hex: '#9a5363' }
			])
		).toEqual([
			{ name: 'Plum', hex: '#9A5363' },
			{ name: 'Orange', hex: '#F5A572' }
		]);
	});

	it('leaves a duplicate-free palette untouched', () => {
		const swatches = [
			{ name: 'a', hex: '#111111' },
			{ name: 'b', hex: '#222222' }
		];
		expect(dedupePalette(swatches)).toEqual(swatches);
	});
});
