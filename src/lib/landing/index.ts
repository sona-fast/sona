// Landing-layout registry. `landingLayout` (a site setting) picks which hero the
// public home page renders; the home page maps the id to a component. To add a
// layout: add an entry here and a branch in (public)/+page@.svelte.

export interface LandingLayoutOption {
	id: string;
	label: string;
}

export const LANDING_LAYOUTS: LandingLayoutOption[] = [
	{ id: 'mosaic', label: 'Mosaic hero — tilted wall of artwork' },
	{ id: 'threePath', label: 'Three paths — splash hub routing to /art, /connect and /share' }
];

export const DEFAULT_LANDING_LAYOUT = 'mosaic';

/**
 * The threePath splash headline. The splash identity block is the CHARACTER, so
 * an explicit owner name wins (siteName stays the domain brand in the header,
 * tab title and footer-mark). Without one, fall back to the site name with a
 * trailing domain-style suffix stripped ("akito.dog" → "AKITO").
 */
export function splashWordmark(ownerName: string, siteName: string): string {
	return (ownerName || siteName.replace(/\.[a-z]+$/i, '')).toUpperCase();
}
