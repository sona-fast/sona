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

	it('names the platform beside each handle toggle, where the card draws an icon', () => {
		// The icons are for the printed card; a checkbox is settings UI and has to
		// say which platform it turns on in words, and which account, since the
		// operator can have more than one per platform elsewhere on the site.
		expect(source).toMatch(
			/bind:checked=\{handleOn\[i\]\}[\s\S]*?\{SOCIAL_PLATFORM_NAMES\[handle\.platform\]\}[\s\S]*?class="handle-value">\{handle\.value\}/
		);
	});

	it('groups the includes and the handles as two fieldsets', () => {
		// Per the approved mock: what goes on the card, then which accounts.
		expect(source).toMatch(/<legend>\{m\.con_card_include\(\)\}<\/legend>/);
		expect(source).toMatch(/<legend>\{m\.con_card_handles\(\)\}<\/legend>/);
	});

	it('keeps the card whole when the avatar cannot be fetched', () => {
		// The QR is the point of the card, and the back never touches the avatar.
		expect(source).toMatch(/avatarFailed = true;[\s\S]*?return null;/);
	});

	it('separates "saved without your avatar" from "nothing saved"', () => {
		// avatarFailed is the embed path's alone; a raster failure must never claim
		// a file was saved. Both save paths route their catch to rasterFailed.
		expect(source.match(/avatarFailed = true/g) ?? []).toHaveLength(1);
		// All THREE save paths, print included: it can fail too (the sheet is built
		// and handed to the browser), and a silent one leaves no file and no message.
		expect(source).toMatch(/downloadPrint[\s\S]*?catch \{[\s\S]*?rasterFailed = true;/);
		expect(source).toMatch(/savePhone[\s\S]*?catch \{[\s\S]*?rasterFailed = true;/);
		expect(source).toMatch(/saveFront[\s\S]*?catch \{[\s\S]*?rasterFailed = true;/);
		// A canvas with no context and an encode with no blob are failures, not
		// silent no-ops.
		expect(source).toMatch(/if \(!ctx\) throw/);
		expect(source).toMatch(/if \(!blob\) throw/);
	});

	it('renders the status region whether or not anything failed', () => {
		// A live region created together with its text is not reliably announced,
		// so the <p> is unconditional and the {#if} sits inside it.
		expect(source).toMatch(
			/<p class="status-line" role="status">[\s\S]*?\{#if avatarFailed\}[\s\S]*?\{#if rasterFailed\}[\s\S]*?<\/p>/
		);
		// And the regression the positive match alone does not forbid: an {#if}
		// WRAPPING the <p> puts the region and its text into the DOM together,
		// which is the arrangement that goes unannounced.
		expect(source).not.toMatch(
			/\{#if[^}]*(avatarFailed|rasterFailed)[^}]*\}\s*<p class="status-line"/
		);
	});

	it('says which fields each preview face is carrying, in its accessible name', () => {
		// The toggles are the whole point of the control, and a bare "front of the
		// con card" is the same name whichever boxes are ticked.
		expect(source).toMatch(/previewFront[\s\S]*?title: withFields\(m\.con_card_title_front/);
		expect(source).toMatch(/previewBack[\s\S]*?title: withFields\(m\.con_card_title_back/);
		// Read off the shared object, so the list cannot disagree with the card.
		expect(source).toMatch(/shared\.species \? m\.con_card_field_species\(\)/);
		expect(source).toMatch(/shared\.handles\.length \? m\.con_card_handles\(\)/);
	});

	it('clears both failure flags at the top of all three save paths', () => {
		// One state machine across the three buttons: a press reports on itself, so
		// a transient avatar fetch failure is retried rather than remembered
		// forever, and a stale "couldn't save" never sits over a save that worked.
		for (const handler of ['downloadPrint', 'savePhone', 'saveFront']) {
			expect(source, handler).toMatch(
				new RegExp(`${handler}\\(\\)[\\s\\S]*?rasterFailed = false;\\s*avatarFailed = false;`)
			);
		}
		// The cached data URI is NOT cleared with the flag: a success stays one fetch.
		expect(source).not.toMatch(/avatarData = null/);
	});

	it('marks a save in progress with aria-busy rather than disabling the button', () => {
		// A control that leaves the tab order mid-press drops the focus the operator
		// was holding; re-entry is guarded in the handler instead.
		expect(source).not.toMatch(/disabled=\{saving/);
		for (const flag of ['savingPrint', 'savingPhone', 'savingFront']) {
			expect(source, flag).toContain(`aria-busy={${flag}}`);
			expect(source, flag).toMatch(new RegExp(`if \\(${flag}\\) return;`));
		}
	});
});
