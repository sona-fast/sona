import { describe, it, expect } from 'vitest';
import { galleryTabs, type GallerySection } from './gallery-tabs';

const none = { fursuitEnabled: false, stickersEnabled: false, vrEnabled: false };
const all = { fursuitEnabled: true, stickersEnabled: true, vrEnabled: true };

const sections = (tabs: { section: GallerySection }[]) => tabs.map((t) => t.section);

describe('galleryTabs: which tabs show', () => {
	it('shows all four, in order, when every section has content', () => {
		expect(sections(galleryTabs({ current: 'artwork', ...all }))).toEqual([
			'artwork',
			'fursuit',
			'stickers',
			'vr'
		]);
	});

	it('hides a section without content on every other page', () => {
		for (const current of ['artwork', 'fursuit', 'vr'] as const) {
			const tabs = galleryTabs({ current, ...all, stickersEnabled: false });
			expect(sections(tabs), current).not.toContain('stickers');
		}
		for (const current of ['artwork', 'fursuit', 'stickers'] as const) {
			const tabs = galleryTabs({ current, ...all, vrEnabled: false });
			expect(sections(tabs), current).not.toContain('vr');
		}
		for (const current of ['artwork', 'stickers', 'vr'] as const) {
			const tabs = galleryTabs({ current, ...all, fursuitEnabled: false });
			expect(sections(tabs), current).not.toContain('fursuit');
		}
	});

	it("keeps the current section's own tab even when it has no content", () => {
		// /stickers and /vr render an honest empty state at zero, under their own tab.
		expect(sections(galleryTabs({ current: 'stickers', ...none }))).toEqual(['artwork', 'stickers']);
		expect(sections(galleryTabs({ current: 'vr', ...none }))).toEqual(['artwork', 'vr']);
	});

	it('renders nothing when only Artwork would show', () => {
		expect(galleryTabs({ current: 'artwork', ...none })).toEqual([]);
	});
});

describe('galleryTabs: the current tab', () => {
	for (const current of ['artwork', 'fursuit', 'stickers', 'vr'] as const) {
		it(`marks exactly ${current} as current`, () => {
			const tabs = galleryTabs({ current, ...all });
			expect(tabs.filter((t) => t.current).map((t) => t.section)).toEqual([current]);
		});
	}
});

describe('galleryTabs: links', () => {
	const href = (tabs: { section: GallerySection; href: string }[], s: GallerySection) =>
		tabs.find((t) => t.section === s)?.href;

	it('links every tab to its page', () => {
		const tabs = galleryTabs({ current: 'stickers', ...all });
		expect(tabs.map((t) => t.href)).toEqual(['/gallery', '/gallery?view=fursuit', '/stickers', '/vr']);
	});

	it('keeps the gallery filters when switching between Artwork and Fursuit', () => {
		const galleryParams = new URLSearchParams('q=fox&tag=sketch&page=3');
		const onArtwork = galleryTabs({ current: 'artwork', ...all, galleryParams });
		expect(href(onArtwork, 'fursuit')).toBe('/gallery?q=fox&tag=sketch&view=fursuit');
		// The page number belongs to the view it was picked in.
		expect(href(onArtwork, 'artwork')).toBe('/gallery?q=fox&tag=sketch');

		const onFursuit = galleryTabs({
			current: 'fursuit',
			...all,
			galleryParams: new URLSearchParams('view=fursuit&photographer=Kit&q=fox')
		});
		expect(href(onFursuit, 'artwork')).toBe('/gallery?photographer=Kit&q=fox');
		expect(href(onFursuit, 'fursuit')).toBe('/gallery?view=fursuit&photographer=Kit&q=fox');
	});

	it('leaves the Stickers and VR links bare, whatever the gallery query', () => {
		const tabs = galleryTabs({ current: 'artwork', ...all, galleryParams: new URLSearchParams('q=fox') });
		expect(href(tabs, 'stickers')).toBe('/stickers');
		expect(href(tabs, 'vr')).toBe('/vr');
	});

	it('links the current Artwork tab to the current URL, page included, so clicking it stays put', () => {
		const onArtwork = galleryTabs({
			current: 'artwork',
			...all,
			galleryParams: new URLSearchParams('q=fox&page=3'),
			currentHref: '/gallery?q=fox&page=3'
		});
		expect(href(onArtwork, 'artwork')).toBe('/gallery?q=fox&page=3');
		// The other view still starts at page 1.
		expect(href(onArtwork, 'fursuit')).toBe('/gallery?q=fox&view=fursuit');
	});

	it('links the current Stickers tab to the filtered /stickers URL, not bare /stickers', () => {
		const onStickers = galleryTabs({ current: 'stickers', ...all, currentHref: '/stickers?emoji=%F0%9F%A6%8A' });
		expect(href(onStickers, 'stickers')).toBe('/stickers?emoji=%F0%9F%A6%8A');
		expect(href(onStickers, 'artwork')).toBe('/gallery');
		expect(href(onStickers, 'vr')).toBe('/vr');
	});

	it("ignores a query passed on /stickers or /vr: their filters aren't the gallery's", () => {
		const tabs = galleryTabs({ current: 'stickers', ...all, galleryParams: new URLSearchParams('q=😀') });
		expect(href(tabs, 'artwork')).toBe('/gallery');
	});
});

describe('galleryTabs: switching in place', () => {
	const inPlace = (tabs: { section: GallerySection; inPlace: boolean }[]) =>
		tabs.filter((t) => t.inPlace).map((t) => t.section);

	// The Artwork/Fursuit switch stays on /gallery, so it updates in place: no
	// scroll to the top, focus kept, no new history entry (as updateFilter does).
	it('marks Artwork and Fursuit in place on /gallery, never Stickers or VR', () => {
		for (const current of ['artwork', 'fursuit'] as const) {
			expect(inPlace(galleryTabs({ current, ...all })), current).toEqual(['artwork', 'fursuit']);
		}
	});

	// Leaving /gallery, or arriving from /stickers or /vr, is a new page.
	it('marks nothing in place on /stickers or /vr', () => {
		for (const current of ['stickers', 'vr'] as const) {
			expect(inPlace(galleryTabs({ current, ...all })), current).toEqual([]);
		}
	});
});
