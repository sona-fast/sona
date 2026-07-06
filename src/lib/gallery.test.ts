import { describe, it, expect } from 'vitest';
import { resolveGallerySort, isValidGallerySort, DEFAULT_GALLERY_SORT } from './gallery';

// resolveGallerySort is the fallback chain the gallery load relies on: an
// explicit ?sort= must win (so shared/bookmarked sorted links stay stable),
// then the site's configured default, then the hardcoded 'newest'.
describe('resolveGallerySort', () => {
	it('a valid URL param wins over the configured default', () => {
		expect(resolveGallerySort('oldest', 'commissioned-newest')).toBe('oldest');
	});

	it('applies the configured default when no param is present', () => {
		expect(resolveGallerySort(null, 'commissioned-newest')).toBe('commissioned-newest');
		expect(resolveGallerySort('', 'commissioned-oldest')).toBe('commissioned-oldest');
	});

	it("falls back to 'newest' when neither param nor a valid default is set", () => {
		expect(resolveGallerySort(null, '')).toBe(DEFAULT_GALLERY_SORT);
		expect(resolveGallerySort(null, '')).toBe('newest');
	});

	it('ignores an unknown param and uses the configured default instead', () => {
		expect(resolveGallerySort('bogus', 'commissioned-newest')).toBe('commissioned-newest');
	});

	it('ignores an unknown configured default and uses the hardcoded fallback', () => {
		expect(resolveGallerySort(null, 'bogus')).toBe('newest');
	});
});

describe('isValidGallerySort', () => {
	it('accepts the four implemented sort keys and rejects anything else', () => {
		for (const key of ['newest', 'oldest', 'commissioned-newest', 'commissioned-oldest']) {
			expect(isValidGallerySort(key)).toBe(true);
		}
		expect(isValidGallerySort('random')).toBe(false);
		expect(isValidGallerySort('')).toBe(false);
	});
});
