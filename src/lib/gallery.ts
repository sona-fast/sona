// The gallery's sort modes. All four are implemented by galleryOrderBy (see
// $lib/server/gallery-order.ts); `galleryDefaultSort` (a site setting) picks
// which one applies when a request carries no explicit ?sort=.
export const GALLERY_SORTS = [
	'newest',
	'oldest',
	'commissioned-newest',
	'commissioned-oldest'
] as const;
export type GallerySort = (typeof GALLERY_SORTS)[number];

// Hardcoded fallback — preserves existing behaviour for forks that never set a
// default (sort by newest upload).
export const DEFAULT_GALLERY_SORT: GallerySort = 'newest';

export function isValidGallerySort(value: string): value is GallerySort {
	return (GALLERY_SORTS as readonly string[]).includes(value);
}

/**
 * Resolve the sort the gallery should use. An explicit, valid URL param wins so
 * shared/bookmarked sorted links stay stable; otherwise the site's configured
 * default applies; otherwise the hardcoded fallback. Unknown values are ignored
 * at each step.
 */
export function resolveGallerySort(param: string | null, settingDefault: string): GallerySort {
	if (param && isValidGallerySort(param)) return param;
	if (isValidGallerySort(settingDefault)) return settingDefault;
	return DEFAULT_GALLERY_SORT;
}

// The grid context a detail page pages through (SONA-179): the grid's filters
// and, when the visitor picked one, its sort. The grid writes it into each
// card's link as query params; the detail page reads it back to find its
// previous and next pieces in that same order. Same param names as /gallery,
// so the query string reads like the grid URL it came from.
const CONTEXT_PARAMS = {
	search: 'q',
	tag: 'tag',
	artist: 'artist',
	character: 'character'
} as const;

// Every filter feeds an unindexed scan, so a filter longer than any real title,
// tag or name is cut here rather than handed to D1. 200 is the longest value
// the site stores: the admin forms and the registry import cap titles and
// artist and character names at 200, and the artist and character filters
// match exactly, so a shorter cap would break links to a long name. The grid
// and the detail page both read through galleryFilterParam, so a card link
// round-trips.
export const MAX_FILTER_LENGTH = 200;

/** A filter param from the URL, '' when absent, cut to MAX_FILTER_LENGTH. */
export function galleryFilterParam(params: URLSearchParams, name: string): string {
	return (params.get(name) || '').slice(0, MAX_FILTER_LENGTH);
}

/** The grid filters a detail page can carry. On the server, `artist` is the
 *  resolved current name: the grid resolves a former name before it filters. */
export interface GalleryFilters {
	search: string;
	tag: string;
	artist: string;
	character: string;
}

export interface GalleryContext {
	filters: GalleryFilters;
	/** The explicit sort, or null for the site's default. */
	sort: string | null;
	/** The context as a query string with its leading '?', or '' for none. */
	query: string;
}

/**
 * The query string a grid card links to its detail page with: each non-empty
 * filter, and the sort only when the grid URL named one. A grid on the default
 * sort stays on the default, so the links stay short and follow the site
 * setting if it changes.
 */
export function galleryContextQuery(
	filters: Partial<GalleryFilters>,
	sort: string | null
): string {
	const params = new URLSearchParams();
	for (const [key, param] of Object.entries(CONTEXT_PARAMS)) {
		const value = filters[key as keyof typeof CONTEXT_PARAMS];
		if (value) params.set(param, value);
	}
	if (sort && isValidGallerySort(sort)) params.set('sort', sort);
	const query = params.toString();
	return query ? `?${query}` : '';
}

/** Reads a detail page's grid context back out of its URL. */
export function galleryContextFromParams(params: URLSearchParams): GalleryContext {
	const filters = {
		search: galleryFilterParam(params, CONTEXT_PARAMS.search),
		tag: galleryFilterParam(params, CONTEXT_PARAMS.tag),
		artist: galleryFilterParam(params, CONTEXT_PARAMS.artist),
		character: galleryFilterParam(params, CONTEXT_PARAMS.character)
	};
	const sortParam = params.get('sort');
	const sort = sortParam && isValidGallerySort(sortParam) ? sortParam : null;
	return { filters, sort, query: galleryContextQuery(filters, sort) };
}

/**
 * A pagination link that keeps the current query (search, filters, sort) and
 * replaces only `page`. Page 1 drops the param so it matches the unpaged URL.
 */
export function galleryPageHref(pathname: string, params: URLSearchParams, page: number): string {
	const next = new URLSearchParams(params);
	if (page > 1) next.set('page', String(page));
	else next.delete('page');
	const query = next.toString();
	return query ? `${pathname}?${query}` : pathname;
}
