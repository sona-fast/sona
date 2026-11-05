import { describe, it, expect } from 'vitest';
import {
	resolveGallerySort,
	isValidGallerySort,
	DEFAULT_GALLERY_SORT,
	galleryContextQuery,
	galleryContextFromParams,
	galleryFilterParam,
	MAX_FILTER_LENGTH,
	galleryPageHref,
	collectionContextQuery,
	isValidCollectionSlug
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
		expect(back).toEqual({ filters: { search: '', tag: '', artist: '', character: '' }, sort: null, collection: null, query: '' });
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

// SONA-179: a piece opened from /collections/[slug] carries ?collection=<slug>.
// The slug reaches a D1 lookup and is echoed onto the next page's links, so
// only the shape the admin form's slugify produces is accepted.
describe('collection context', () => {
	it('round-trips a collection slug through the link', () => {
		const query = collectionContextQuery('con-badges-2026');
		expect(query).toBe('?collection=con-badges-2026');
		const back = galleryContextFromParams(new URL(`https://x.test/gallery/a${query}`).searchParams);
		expect(back).toEqual({
			filters: { search: '', tag: '', artist: '', character: '' },
			sort: null,
			collection: 'con-badges-2026',
			query
		});
	});

	it('wins over gallery filters and a sort beside it, and drops them from the links', () => {
		const back = galleryContextFromParams(new URLSearchParams('tag=ych&sort=oldest&collection=badges&q=fox'));
		expect(back.collection).toBe('badges');
		expect(back.filters).toEqual({ search: '', tag: '', artist: '', character: '' });
		expect(back.sort).toBeNull();
		expect(back.query).toBe('?collection=badges');
	});

	it('reads the first of repeated collection params', () => {
		expect(galleryContextFromParams(new URLSearchParams('collection=a&collection=b')).collection).toBe('a');
	});

	const forged = [
		'',
		'Badges',
		'con badges',
		'con--badges',
		'-badges',
		'badges-',
		'../admin',
		'badges/../x',
		'badges?x=1',
		'badges&tag=ych',
		'バッジ',
		'badges%00',
		'x'.repeat(MAX_FILTER_LENGTH + 1)
	];
	for (const slug of forged) {
		it(`rejects ${JSON.stringify(slug.length > 40 ? `${slug.slice(0, 10)}… (${slug.length} chars)` : slug)} and reads the rest as gallery context`, () => {
			expect(isValidCollectionSlug(slug)).toBe(false);
			expect(collectionContextQuery(slug)).toBe('');
			const params = new URLSearchParams({ collection: slug, tag: 'ych' });
			const back = galleryContextFromParams(params);
			expect(back.collection).toBeNull();
			expect(back.query).toBe('?tag=ych');
		});
	}

	it('accepts a slug at the length cap', () => {
		const slug = 'a'.repeat(MAX_FILTER_LENGTH);
		expect(isValidCollectionSlug(slug)).toBe(true);
		expect(galleryContextFromParams(new URLSearchParams({ collection: slug })).collection).toBe(slug);
	});
});

describe('galleryFilterParam', () => {
	it('reads a param, empty when absent, and truncates past the cap', () => {
		const params = new URLSearchParams({ q: 'fox', tag: 'y'.repeat(MAX_FILTER_LENGTH + 50) });
		expect(galleryFilterParam(params, 'q')).toBe('fox');
		expect(galleryFilterParam(params, 'artist')).toBe('');
		expect(galleryFilterParam(params, 'tag')).toBe('y'.repeat(MAX_FILTER_LENGTH));
	});
});

// The pagination links must carry the active filters: a link built from
// scratch ("?page=2") silently drops the search, tag, artist, character, and sort.
describe('galleryPageHref', () => {
	it('keeps every filter and replaces the page', () => {
		const params = new URLSearchParams('q=fox&tag=reference&artist=alice&character=sparky&sort=oldest&page=2');
		expect(galleryPageHref('/gallery', params, 3)).toBe('/gallery?q=fox&tag=reference&artist=alice&character=sparky&sort=oldest&page=3');
	});

	it('drops the page param for page 1', () => {
		expect(galleryPageHref('/gallery', new URLSearchParams('tag=reference&page=2'), 1)).toBe('/gallery?tag=reference');
	});

	it('returns the bare path when page 1 has no filters', () => {
		expect(galleryPageHref('/gallery', new URLSearchParams('page=4'), 1)).toBe('/gallery');
	});

	it('preserves repeated params', () => {
		expect(galleryPageHref('/gallery', new URLSearchParams('tag=a&tag=b'), 2)).toBe('/gallery?tag=a&tag=b&page=2');
	});

	it('does not change the params it was given', () => {
		const params = new URLSearchParams('q=fox&page=2');
		galleryPageHref('/gallery', params, 5);
		expect(params.toString()).toBe('q=fox&page=2');
	});
});
