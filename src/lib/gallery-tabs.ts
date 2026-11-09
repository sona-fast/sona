// The tab bar shared by /gallery, /stickers and /vr. The four sections live
// under the Gallery nav item, and every tab is a link to its section, so the
// bar reads the same wherever it shows.

import { ARTWORK_FILTER_PARAMS, FURSUIT_FILTER_PARAMS, galleryPageHref } from '$lib/gallery';

export type GallerySection = 'artwork' | 'fursuit' | 'stickers' | 'vr';

export type GalleryTab = {
	section: GallerySection;
	href: string;
	current: boolean;
	/** Switching Artwork and Fursuit on /gallery stays on the page, so it
	 * updates in place, as a filter change does: no scroll to the top, focus
	 * kept, and the history entry replaced. Every other tab is a new page. */
	inPlace: boolean;
};

export type GalleryTabsInput = {
	/** The section this page shows. Its own tab always shows. */
	current: GallerySection;
	fursuitEnabled: boolean;
	stickersEnabled: boolean;
	vrEnabled: boolean;
	/** On /gallery, the URL's query. Switching between Artwork and Fursuit
	 * keeps the target view's own filters and drops the other view's, which
	 * would do nothing there. Params neither view reads ride along. */
	galleryParams?: URLSearchParams;
	/** The current URL's path and query. The current tab links here, so
	 * clicking it keeps the page number and filters rather than resetting them. */
	currentHref?: string;
};

function galleryHref(params: URLSearchParams | undefined, view: 'artwork' | 'fursuit'): string {
	const next = new URLSearchParams(params);
	// The views share no filter: a photographer means nothing to the Artwork
	// grid, nor a search to Fursuit Photos.
	for (const key of view === 'fursuit' ? ARTWORK_FILTER_PARAMS : FURSUIT_FILTER_PARAMS) next.delete(key);
	if (view === 'fursuit') next.set('view', 'fursuit');
	else next.delete('view');
	// Page 1: a page number belongs to the view it was picked in.
	return galleryPageHref('/gallery', next, 1);
}

/**
 * The tabs to render, in order. Artwork always shows. Fursuit, Stickers and
 * VR show while they have content (the same content gate as the nav), and
 * the current section shows even without content, so its page keeps its own
 * tab. Returns an empty list when only one tab would show: a bar with one
 * tab has nothing to switch to.
 */
export function galleryTabs({
	current,
	fursuitEnabled,
	stickersEnabled,
	vrEnabled,
	galleryParams,
	currentHref
}: GalleryTabsInput): GalleryTab[] {
	const onGallery = current === 'artwork' || current === 'fursuit';
	const params = onGallery ? galleryParams : undefined;
	const all: [GallerySection, boolean, string][] = [
		['artwork', true, galleryHref(params, 'artwork')],
		['fursuit', fursuitEnabled, galleryHref(params, 'fursuit')],
		['stickers', stickersEnabled, '/stickers'],
		['vr', vrEnabled, '/vr']
	];
	const tabs = all
		.filter(([section, enabled]) => enabled || section === current)
		.map(([section, , href]) => {
			const isCurrent = section === current;
			const inPlace = onGallery && (section === 'artwork' || section === 'fursuit');
			return { section, href: (isCurrent && currentHref) || href, current: isCurrent, inPlace };
		});
	return tabs.length > 1 ? tabs : [];
}
