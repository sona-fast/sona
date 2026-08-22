import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SOCIAL_ICON_ART } from './social-icon-paths';
import { SOCIAL_PLATFORM_NAMES } from './social-label';

// The artwork here is a copy of what the icon components draw, so the copy is
// pinned to its source: a redrawn logo that only lands in the component would
// otherwise leave the con card printing the old one indefinitely.

const COMPONENTS: Record<keyof typeof SOCIAL_PLATFORM_NAMES, string> = {
	twitter: 'TwitterIcon',
	bluesky: 'BlueskyIcon',
	telegram: 'TelegramIcon',
	furaffinity: 'FurAffinityIcon',
	furtrack: 'FurTrackIcon',
	deviantart: 'DeviantArtIcon',
	patreon: 'PatreonIcon',
	instagram: 'InstagramIcon'
};

function iconSource(component: string): string {
	return readFileSync(new URL(`./components/icons/${component}.svelte`, import.meta.url), 'utf8');
}

/** What the component draws, reduced to the form the table stores: everything
 *  inside the root <svg>, minus the comments that explain the drawing, with
 *  whitespace collapsed so a reformat of the component is not a redraw of it. */
function componentShapes(component: string): string {
	const source = iconSource(component);
	const inner = source.slice(
		source.indexOf('>', source.indexOf('<svg')) + 1,
		source.lastIndexOf('</svg>')
	);
	// Strip to a fixed point rather than in one pass: a single sweep over nested
	// or overlapping comment markers can leave a bare <!-- behind, which is what
	// CodeQL's incomplete-multi-character-sanitization rule is about. Nothing
	// hostile reaches this helper, since it reads our own components off disk,
	// but a comparison that silently keeps a fragment of what it meant to remove
	// is wrong on its own terms.
	let withoutComments = inner;
	let previous: string;
	do {
		previous = withoutComments;
		withoutComments = withoutComments.replaceAll(/<!--[\s\S]*?-->/g, '');
	} while (withoutComments !== previous);

	return withoutComments
		.replaceAll(/\s+/g, ' ')
		.replaceAll(/\s*\/>/g, '/>')
		.replaceAll(/>\s+</g, '><')
		.trim();
}

describe('SOCIAL_ICON_ART tracks the icon components', () => {
	it('covers every platform, so no social reaches the card as bare text', () => {
		expect(Object.keys(SOCIAL_ICON_ART).sort()).toEqual(Object.keys(SOCIAL_PLATFORM_NAMES).sort());
		expect(Object.keys(COMPONENTS).sort()).toEqual(Object.keys(SOCIAL_PLATFORM_NAMES).sort());
	});

	for (const [platform, component] of Object.entries(COMPONENTS)) {
		it(`${platform} matches ${component}`, () => {
			const art = SOCIAL_ICON_ART[platform as keyof typeof SOCIAL_ICON_ART];
			expect(art, platform).toBeDefined();
			expect(art?.shapes).toBe(componentShapes(component));
			expect(iconSource(component)).toContain(`viewBox="0 0 ${art?.viewBox} ${art?.viewBox}"`);
			// The card sets one fill on the wrapper and lets it inherit, which a
			// shape carrying a fill of its own would ignore: the mark would print
			// black on the dark variant.
			expect(art?.shapes).not.toContain('fill=');
		});
	}

	it('carries FurTrack, whose mark is more than one shape', () => {
		// The reason an entry is a fragment rather than a path. Pinned so that the
		// multi-shape case stays exercised by a real platform.
		const shapes = SOCIAL_ICON_ART.furtrack?.shapes ?? '';
		expect([...shapes.matchAll(/<(path|circle|ellipse)\b/g)].length).toBeGreaterThan(1);
	});
});
