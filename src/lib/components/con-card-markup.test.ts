import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pin for ConCard, per the link-row-markup.test.ts precedent: nothing
// renders this component under the pure-TS vitest setup, and its two download
// paths would each fail silently in ways only a phone or a printer notices.
// The SVG the paths build is covered for real in con-card.test.ts; what is
// pinned here is which path builds which, and the two browser workarounds the
// paths exist for.

const source = readFileSync(new URL('./ConCard.svelte', import.meta.url), 'utf8');

describe('ConCard download paths', () => {
	it('prints the light variant as an SVG, and saves the dark one as a PNG', () => {
		// The two buttons in the mock are two variants, not two file formats.
		expect(source).toMatch(/downloadPrint[\s\S]*?variant: 'light'[\s\S]*?\.svg`/);
		// Photos on iPhone refuses an SVG, which is the reason this path rasterizes.
		expect(source).toMatch(/savePhone[\s\S]*?variant: 'dark'[\s\S]*?toBlob\(resolve, 'image\/png'\)/);
	});

	it('embeds the art before either download rather than linking to it', () => {
		// An external href is not drawn when the SVG goes through a canvas, and a
		// saved .svg is opened away from the site — both need the data URI.
		expect(source).toMatch(/readAsDataURL/);
		expect(source).toMatch(/downloadPrint[\s\S]*?artHref: await embedArt\(\)/);
		expect(source).toMatch(/savePhone[\s\S]*?artHref: await embedArt\(\)/);
	});

	it('keeps the card whole when the art cannot be fetched', () => {
		// The QR is the point of the card; a failed sheet must not block the save.
		expect(source).toMatch(/artFailed = true;[\s\S]*?return null;/);
	});
});
