import { describe, it, expect } from 'vitest';
import { sanitizeTag, TAG_MAX_LENGTH } from './tags';

// `sanitizeTag` decides what a stored tag name looks like, and three other
// things compare against it: the save path writes what it returns, the
// suggestion chips are keyed off it, and a suggestion the operator already
// typed is dropped by matching through it. A change here moves all three at
// once, so the rule is pinned on its own rather than through whichever caller
// happened to exercise it.

describe('sanitizeTag', () => {
	it('lowercases the name', () => {
		expect(sanitizeTag('FOX')).toBe('fox');
		expect(sanitizeTag('Digital Media')).toBe('digital-media');
	});

	it('maps a run of whitespace to one hyphen', () => {
		// One hyphen, not one per space: "digital  media" and "digital media" are
		// the same tag, and a name that kept both would show twice in the list.
		expect(sanitizeTag('digital   media')).toBe('digital-media');
		expect(sanitizeTag('sea\tsky')).toBe('sea-sky');
		expect(sanitizeTag('sea\nsky')).toBe('sea-sky');
		// Leading and trailing whitespace goes before anything else, so a padded
		// name does not come back wearing hyphens at both ends.
		expect(sanitizeTag('  fox  ')).toBe('fox');
	});

	it('strips everything outside letters, digits, spaces and hyphens', () => {
		// The comma is the Tags field's own separator, so a name that kept one
		// would split into two tags the next time the field was joined back up.
		expect(sanitizeTag('sea, sky')).toBe('sea-sky');
		expect(sanitizeTag('fox!')).toBe('fox');
		expect(sanitizeTag('<script>')).toBe('script');
		expect(sanitizeTag('fox-kit_2')).toBe('fox-kit2');
		// Nothing left once the junk is gone: the callers read the empty string as
		// "this is not a tag" and drop the entry.
		expect(sanitizeTag('!!!')).toBe('');
		expect(sanitizeTag('')).toBe('');
	});

	it('slices at TAG_MAX_LENGTH', () => {
		expect(sanitizeTag('a'.repeat(TAG_MAX_LENGTH + 10))).toBe('a'.repeat(TAG_MAX_LENGTH));
		expect(sanitizeTag('a'.repeat(TAG_MAX_LENGTH))).toHaveLength(TAG_MAX_LENGTH);
		// The cut comes last, so it counts the hyphens the whitespace became
		// rather than the spaces that were typed.
		// 30 two-letter words: 16 "ab-" groups and a last "ab" fill the 50 exactly.
		const spaced = Array.from({ length: 30 }, () => 'ab').join(' ');
		expect(sanitizeTag(spaced)).toBe(`${'ab-'.repeat(16)}ab`);
	});
});
