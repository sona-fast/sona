// The gallery's sort modes. All four are implemented by the gallery load's
// orderBy (see (public)/gallery/+page.server.ts); `galleryDefaultSort` (a site
// setting) picks which one applies when a request carries no explicit ?sort=.
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
