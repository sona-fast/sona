import { describe, it, expect } from 'vitest';
import { artHasContent, sonaDetails } from './presence';

// Empty sona-details block: every settings field blank, so artHasContent leans
// entirely on the row arguments — the shape a fresh fork with no details has.
const emptySona = sonaDetails({
	sonaSpecies: '',
	sonaBuild: '',
	sonaKeyFeatures: '',
	sonaColors: '[]',
	sonaDos: '',
	sonaDonts: ''
});

describe('artHasContent (#42 content gate)', () => {
	it('is absent when ref sheet, recent art and details are all empty', () => {
		expect(artHasContent(emptySona, null, [])).toBe(false);
	});

	it('is present when any single source exists', () => {
		expect(artHasContent(emptySona, { slug: 'ref' }, [])).toBe(true);
		expect(artHasContent(emptySona, null, [{ slug: 'r' }])).toBe(true);
	});

	// #58: featured art needs no separate argument. A featured image is
	// published + non-NSFW, so it's always part of recentArt's pool — a
	// "featured but no recent art" state is unreachable, and a non-empty
	// recentArt already gates the page present.
	it('counts featured art via recentArt (featured is a subset of the recent pool)', () => {
		expect(artHasContent(emptySona, null, [{ slug: 'featured-also-recent' }])).toBe(true);
	});
});
