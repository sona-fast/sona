import { describe, it, expect } from 'vitest';
import { mergeSuggestions } from './palette-merge';

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
});
