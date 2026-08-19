import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pin for ConCard, per the link-row-markup.test.ts precedent: nothing
// renders this component under the pure-TS vitest setup, and its three download
// paths would each fail silently in ways only a phone or a printer notices.
// The SVG the paths build is covered for real in con-card.test.ts; what is
// pinned here is which path builds which face, and the browser workarounds the
// paths exist for.

const source = readFileSync(new URL('./ConCard.svelte', import.meta.url), 'utf8');

describe('ConCard download paths', () => {
	it('prints one sheet of both faces, and saves the BACK as the phone PNG', () => {
		// Print is the sheet, not a face: the operator prints once and cuts twice.
		expect(source).toMatch(/downloadPrint[\s\S]*?conCardPrintSheetSvg\([\s\S]*?\.svg`/);
		// At a con the phone has one job, and the front adds nothing to a screen
		// the person holding it is already looking at.
		expect(source).toMatch(
			/savePhone[\s\S]*?conCardFaceSvg\('back', \{[\s\S]*?variant: 'dark'[\s\S]*?-back\.png`/
		);
	});

	it('offers the front as its own dark PNG, below the two buttons', () => {
		expect(source).toMatch(
			/saveFront[\s\S]*?conCardFaceSvg\('front', \{[\s\S]*?variant: 'dark'[\s\S]*?-front\.png`/
		);
		// Low emphasis on purpose: the back is the save that matters.
		expect(source).toMatch(/class="link-action" onclick=\{saveFront\}/);
	});

	it('rasterizes through a canvas, because Photos on iPhone refuses an SVG', () => {
		expect(source).toMatch(/toBlob\(resolve, 'image\/png'\)/);
	});

	it('embeds the avatar before every download that draws the front', () => {
		// An external href is not drawn when the SVG goes through a canvas, and a
		// saved .svg is opened away from the site; both need the data URI.
		expect(source).toMatch(/readAsDataURL/);
		expect(source).toMatch(/downloadPrint[\s\S]*?avatarHref: await embedAvatar\(\)/);
		expect(source).toMatch(/saveFront[\s\S]*?avatarHref: await embedAvatar\(\)/);
	});

	it('previews both faces in the light variant', () => {
		expect(source).toMatch(/previewFront[\s\S]*?conCardFaceSvg\('front', \{[\s\S]*?variant: 'light'/);
		expect(source).toMatch(/previewBack[\s\S]*?conCardFaceSvg\('back', \{[\s\S]*?variant: 'light'/);
	});

	it('names the platform beside each include toggle, where the card draws an icon', () => {
		// The icons are for the printed card; a checkbox is settings UI and has to
		// say which platform it turns on in words.
		expect(source).toMatch(
			/bind:checked=\{handleOn\[i\]\} \/> \{SOCIAL_PLATFORM_NAMES\[handle\.platform\]\}/
		);
	});

	it('keeps the card whole when the avatar cannot be fetched', () => {
		// The QR is the point of the card, and the back never touches the avatar.
		expect(source).toMatch(/avatarFailed = true;[\s\S]*?return null;/);
	});
});
