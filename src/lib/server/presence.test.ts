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

describe('artHasContent — featured art counts as content (#58)', () => {
	it('is absent when ref sheet, featured, recent and details are all empty', () => {
		expect(artHasContent(emptySona, null, [], [])).toBe(false);
	});

	it('is present when only featured art exists (no ref sheet, no recent, no details)', () => {
		expect(artHasContent(emptySona, null, [], [{ slug: 'art-1' }])).toBe(true);
	});

	it('stays present via other sources when featured is empty', () => {
		expect(artHasContent(emptySona, { slug: 'ref' }, [], [])).toBe(true);
		expect(artHasContent(emptySona, null, [{ slug: 'r' }], [])).toBe(true);
	});
});
