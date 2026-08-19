import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SOCIAL_ICON_PATHS, SOCIAL_ICON_VIEWBOX } from './social-icon-paths';
import { SOCIAL_PLATFORM_NAMES } from './social-label';

// The path data here is a copy of what the icon components draw, so the copy is
// pinned to its source: a redrawn logo that only lands in the component would
// otherwise leave the con card printing the old one indefinitely.

const COMPONENTS: Partial<Record<keyof typeof SOCIAL_PLATFORM_NAMES, string>> = {
	twitter: 'TwitterIcon',
	bluesky: 'BlueskyIcon',
	telegram: 'TelegramIcon',
	furaffinity: 'FurAffinityIcon',
	deviantart: 'DeviantArtIcon',
	patreon: 'PatreonIcon',
	instagram: 'InstagramIcon'
};

function iconSource(component: string): string {
	return readFileSync(new URL(`./components/icons/${component}.svelte`, import.meta.url), 'utf8');
}

describe('SOCIAL_ICON_PATHS tracks the icon components', () => {
	for (const [platform, component] of Object.entries(COMPONENTS)) {
		it(`${platform} matches ${component}`, () => {
			const paths = [...iconSource(component).matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
			expect(paths).toHaveLength(1);
			expect(SOCIAL_ICON_PATHS[platform as keyof typeof SOCIAL_ICON_PATHS]).toBe(paths[0]);
		});
	}

	it('scales from the viewBox the components are drawn in', () => {
		for (const component of Object.values(COMPONENTS)) {
			expect(iconSource(component)).toContain(
				`viewBox="0 0 ${SOCIAL_ICON_VIEWBOX} ${SOCIAL_ICON_VIEWBOX}"`
			);
		}
	});

	it('leaves out FurTrack, whose mark is not one path', () => {
		// The reason the table is partial, pinned so that a future single-path
		// FurTrack logo is noticed rather than quietly kept out.
		const source = iconSource('FurTrackIcon');
		expect([...source.matchAll(/<(path|circle|ellipse)\b/g)].length).toBeGreaterThan(1);
		expect(SOCIAL_ICON_PATHS.furtrack).toBeUndefined();
	});
});
