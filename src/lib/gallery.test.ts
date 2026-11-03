import { describe, it, expect } from 'vitest';
import {
	resolveGallerySort,
	isValidGallerySort,
	DEFAULT_GALLERY_SORT,
	galleryContextQuery,
	galleryContextFromParams,
	galleryFilterParam,
	MAX_FILTER_LENGTH
} from './gallery';

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

// SONA-179: the grid writes its context into each card link and the detail
// page reads it back; a round trip that drops or garbles a filter would page
// the visitor through a different grid than the one they saw.
describe('gallery context query', () => {
	it('round-trips every filter and an explicit sort through the link', () => {
		const filters = { search: 'fox & hound', tag: 'ych', artist: 'Kés Forge', character: 'Ember' };
		const query = galleryContextQuery(filters, 'commissioned-oldest');
		const back = galleryContextFromParams(new URL(`https://x.test/gallery/a${query}`).searchParams);
		expect(back.filters).toEqual(filters);
		expect(back.sort).toBe('commissioned-oldest');
		// The detail page re-emits the same context on its own links.
		expect(back.query).toBe(query);
	});

	it('is empty for an unfiltered grid on the default sort, so plain links stay plain', () => {
		expect(galleryContextQuery({ search: '', tag: '', artist: '', character: '' }, null)).toBe('');
		const back = galleryContextFromParams(new URLSearchParams());
		expect(back).toEqual({ filters: { search: '', tag: '', artist: '', character: '' }, sort: null, query: '' });
	});

	it('drops an unknown sort instead of carrying it forward', () => {
		expect(galleryContextQuery({}, 'random')).toBe('');
		expect(galleryContextFromParams(new URLSearchParams('sort=random&tag=x')).sort).toBeNull();
		expect(galleryContextFromParams(new URLSearchParams('sort=random&tag=x')).query).toBe('?tag=x');
	});

	it('ignores params that are not grid context (page, view, utm tags)', () => {
		const back = galleryContextFromParams(new URLSearchParams('page=3&view=fursuit&utm_source=x&artist=A'));
		expect(back.query).toBe('?artist=A');
	});

	// r2-02: every filter reaches an unindexed LIKE scan, so a huge ?q= on a
	// detail URL must not ride into the query (or back out onto the links).
	it('caps each filter at MAX_FILTER_LENGTH characters', () => {
		const huge = 'x'.repeat(MAX_FILTER_LENGTH + 500);
		const params = new URLSearchParams({ q: huge, tag: huge, artist: huge, character: huge });
		const back = galleryContextFromParams(params);
		const capped = 'x'.repeat(MAX_FILTER_LENGTH);
		expect(back.filters).toEqual({ search: capped, tag: capped, artist: capped, character: capped });
		expect(back.query).toBe(galleryContextQuery(back.filters, null));
	});
});

describe('galleryFilterParam', () => {
	it('reads a param, empty when absent, and truncates past the cap', () => {
		expect(MAX_FILTER_LENGTH).toBe(100);
		const params = new URLSearchParams({ q: 'fox', tag: 'y'.repeat(150) });
		expect(galleryFilterParam(params, 'q')).toBe('fox');
		expect(galleryFilterParam(params, 'artist')).toBe('');
		expect(galleryFilterParam(params, 'tag')).toBe('y'.repeat(100));
	});
});
