import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins, following the copy-command-markup.test.ts precedent: the repo has
// no component renderer under vitest, so the accessibility contract of the tag
// suggestion control (SONA-220) is pinned by reading the markup. Each of these
// is a rule a screen-reader user depends on and a refactor could quietly drop.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const suggestions = read('./TagSuggestions.svelte');
const chips = read('./TagSuggestionChips.svelte');
const ratingNote = read('./TagRatingNote.svelte');
const uploadPage = read('../../routes/admin/upload/+page.svelte');
const editPage = read('../../routes/admin/images/[id]/edit/+page.svelte');
const backfillPage = read('../../routes/admin/images/suggest-tags/+page.svelte');

describe('the tag suggestion live region', () => {
	it('is one element rendered on load and written into, not inserted with its text', () => {
		// A role=status element that appears WITH text already inside announces
		// nothing in NVDA or JAWS. The region is unconditional; only the string
		// inside it changes.
		expect(suggestions).toMatch(/<p class="sr-only" role="status" id=\{statusId\}>\{announcement\}<\/p>/);
		expect(backfillPage).toMatch(/<p class="sr-only" role="status">\{announcement\}<\/p>/);
	});

	it('names the chip group from the visible eyebrow, and describes it with the instruction line', () => {
		// The eyebrow is the line a sighted operator reads above the chips; naming
		// the group from the live region instead gives it a name only a screen
		// reader can see, which then drifts from what is on screen.
		expect(suggestions).toMatch(/labelledBy=\{eyebrowId\}/);
		expect(suggestions).toMatch(/describedBy=\{helpId\}/);
		expect(chips).toMatch(/aria-labelledby=\{labelledBy\} aria-describedby=\{describedBy\}/);
	});
});

describe('the suggest pill', () => {
	it('stays focusable when it cannot run, and refuses the click itself', () => {
		// `disabled` would drop the pill out of the tab order, so a keyboard user
		// would never reach the hint explaining what to do about it.
		expect(suggestions).toMatch(/aria-disabled=\{disabled\}/);
		expect(suggestions).not.toMatch(/(?<!aria-)disabled=\{disabled\}/);
		expect(suggestions).toMatch(/if \(disabled \|\| source === null\) return;/);
	});

	it('refuses the tray\'s Try again by the same rule, since it runs the same lookup', () => {
		// Try again calls suggest(), so it reads `disabled` rather than restating
		// part of it — a URL edited to something unrecognisable stops both.
		expect(suggestions).toMatch(
			/\{#if tray\.retry\}[\s\S]*?aria-disabled=\{disabled\}[\s\S]*?onclick=\{suggest\}/
		);
	});

	it('lists the site\'s existing tags under the field rather than in a tooltip', () => {
		// Both forms showed this as a hint line before the field became a component.
		// A title attribute is a mouse-only affordance: no touch, no keyboard, and
		// screen-reader support for it varies.
		expect(suggestions).toMatch(
			/<small class="hint">\{m\.admin_upload_existing_tags\(\{ tags: existingTags\.join\(', '\) \}\)\}<\/small>/
		);
		expect(suggestions).not.toMatch(/title=\{/);
	});

	it('keeps the "From suggestions" badge out of the label, so the input stays "Tags"', () => {
		// Inside <label for="tags-input"> the badge joins the input's accessible
		// name, which then reads "Tags From suggestions" once tags are applied.
		expect(suggestions).toMatch(
			/<label class="field-label" for=\{inputId\}>\{m\.admin_field_tags\(\)\}<\/label>/
		);
		expect(suggestions).toMatch(
			/<\/label>\s*\{#if suggestion\.kind === 'applied'\}<span class="tag">/
		);
	});

	it('points the Source Post URL field at the hint while that URL is what was refused', () => {
		// The hint lives under the Tags field; the URL it refuses lives in another
		// field of the form. Without this, a screen reader user who tabs to the
		// named field is told nothing about why the lookup will not run.
		expect(suggestions).toMatch(
			/sourceDescribedBy = suggestion\.kind === 'noSource' \? hintId : undefined;/
		);
		for (const page of [uploadPage, editPage]) {
			expect(page).toMatch(/bind:sourceDescribedBy/);
			expect(page).toMatch(/name="sourcePostUrl"\s*\n?\s*aria-describedby=\{sourceDescribedBy\}/);
		}
	});

	it('reads the post the field names, never a stored URL the field has moved away from', () => {
		// On the edit page the stored URL and the field can differ once the operator
		// edits it; the pill, the hint and the lookup all follow the field.
		expect(suggestions).not.toMatch(/imageId/);
		expect(editPage).not.toMatch(/imageId=\{data\.image\.id\}/);
	});
});

describe('focus after a suggestion is accepted or dismissed', () => {
	it('moves to the applied status line, which is focusable for the purpose', () => {
		expect(suggestions).toMatch(/tabindex="-1"[\s\S]{0,40}bind:this=\{statusLine\}/);
		expect(suggestions).toMatch(/await tick\(\);\s*statusLine\?\.focus\(\)/);
	});

	it('returns to the pill after Dismiss, rather than dropping to the body', () => {
		expect(suggestions).toMatch(/function dismiss\(\)[\s\S]*?pill\?\.focus\(\)/);
		// The backfill row's pill only renders once the row is idle again, so the
		// focus call has to wait for that render.
		expect(backfillPage).toMatch(
			/async function dismiss\(id: number\)[\s\S]*?await tick\(\);\s*pills\[id\]\?\.focus\(\)/
		);
	});

	it('keeps focus on the pill after Try again, whose own button is gone with the tray', () => {
		expect(suggestions).toMatch(/kind: 'searching'[\s\S]*?await tick\(\);\s*pill\?\.focus\(\)/);
		expect(backfillPage).toMatch(/kind: 'searching'[\s\S]*?await tick\(\);\s*pills\[id\]\?\.focus\(\)/);
	});

	it('waits for the saved line to render before focusing it on the backfill page', () => {
		expect(backfillPage).toMatch(/await tick\(\);\s*statusLines\[row\.id\]\?\.focus\(\)/);
	});
});

describe('chips', () => {
	it('are toggle buttons carrying their state in aria-pressed', () => {
		// Not checkboxes: the tray is a filter on one suggestion, and a pressed
		// button is what a screen reader reads as "on".
		expect(chips).toMatch(/type="button"[\s\S]*?aria-pressed=\{!leftOut\.has\(tag\)\}/);
	});

	it('mark a left-out tag with a plus rather than only a colour', () => {
		// Both glyphs are decorative: the tag name beside them is the chip's whole
		// accessible name, and aria-pressed already carries the state.
		expect(chips).toMatch(
			/\{#if leftOut\.has\(tag\)\}<Plus size=\{14\} aria-hidden="true" \/>\{:else\}<Check size=\{14\} aria-hidden="true" \/>\{\/if\}/
		);
	});
});

describe('the rating never touches the NSFW checkbox', () => {
	it('offers a button instead of checking the box for the operator', () => {
		// The classifier is a hint about the artwork, not a decision about the
		// gallery; a wrong automatic check publishes a piece under the wrong rating.
		expect(ratingNote).toMatch(/async function markNsfw\(\) \{\n\t\tnsfw = true;/);
		expect(ratingNote).toMatch(/\{#if warn && !nsfw\}/);
		expect(ratingNote).not.toMatch(/rating[\s\S]{0,80}=>[\s\S]{0,40}nsfw = true/);
	});

	it('moves focus to the checkbox it just checked, since its own button is gone', () => {
		expect(ratingNote).toMatch(/nsfw = true;[\s\S]*?await tick\(\);\n\t\tcheckbox\?\.focus\(\)/);
		for (const page of [uploadPage, editPage]) {
			expect(page).toMatch(/name="nsfw" bind:checked=\{nsfw\} bind:this=\{nsfwInput\}/);
		}
	});

	it('marks the warning triangle decorative, so the rating is read once', () => {
		// The label beside it already says the rating; an unlabelled icon here would
		// either be skipped or read as "graphic" in front of the sentence.
		expect(ratingNote).toMatch(
			/\{#if warn\}<TriangleAlert size=\{14\} aria-hidden="true" \/>\{\/if\}/
		);
	});

	it('is referenced by the checkbox rather than sitting inside its label', () => {
		// Inside the label, a screen reader would read the classifier's guess as
		// part of the checkbox's own name.
		for (const page of [uploadPage, editPage]) {
			// Pointed at the note only while there is a note: an aria-describedby that
			// names a missing id describes nothing, and screen readers vary on whether
			// they say so.
			expect(page).toMatch(
				/name="nsfw" bind:checked=\{nsfw\} bind:this=\{nsfwInput\} aria-describedby=\{suggestedRating \? 'tags-rating' : undefined\}/
			);
			expect(page).toMatch(
				/<TagRatingNote rating=\{suggestedRating\} id="tags-rating" bind:nsfw checkbox=\{nsfwInput\} \/>/
			);
		}
	});
});

describe('a dead session', () => {
	it('offers the login page on both surfaces, since another lookup sends the same cookie', () => {
		// trayFor sets signIn only for a 401. Both surfaces have to draw it, or the
		// one that does not leaves a Try again that can only fail the same way.
		for (const source of [suggestions, backfillPage]) {
			// The icon is decorative: the label beside it is the anchor's whole name.
			expect(source).toMatch(
				/\{#if tray\.signIn\}[\s\S]*?<a class="tag-pill" href="\/admin\/login">\s*<LogIn size=\{14\} aria-hidden="true" \/>\s*\{m\.admin_tag_suggest_sign_in\(\)\}\s*<\/a>/
			);
		}
	});
});

describe('the backfill rows', () => {
	it('name every control by its image, since the page repeats them per row', () => {
		expect(backfillPage).toMatch(/m\.admin_suggest_tags_row_suggest\(\{ title: row\.title \}\)/);
		// While the lookup runs the pill reads "Suggesting tags…", so its accessible
		// name has to say the same thing rather than keep the resting label.
		expect(backfillPage).toMatch(/m\.admin_suggest_tags_row_searching\(\{ title: row\.title \}\)/);
		// Try again is not the same action as Suggest, so it is not named like it.
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_row_try_again\(\{ title: row\.title \}\)\}/);
		// And Save reads "Saving" while its own save runs, so its name follows the
		// same way the pill's does — and contains the visible label, which is why
		// neither carries an ellipsis.
		expect(backfillPage).toMatch(/m\.admin_suggest_tags_row_save_label\(\{/);
		expect(backfillPage).toMatch(
			/m\.admin_suggest_tags_row_saving_label\(\{ title: row\.title \}\)/
		);
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_row_dismiss\(\{ title: row\.title \}\)\}/);
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_edit_image_label\(\{ title: row\.title \}\)\}/);
	});

	// The Save button holding its resting width while the label narrows to
	// "Saving", and letting go of it afterwards, is measured in the browser by
	// tests/e2e/suggest-tags.spec.ts — a grep here would keep passing if the line
	// moved into a branch that only some saves reach.

	it('keeps the visible saving label inside the accessible name, in every locale', () => {
		// WCAG 2.5.3 label in name: speech input picks the button by what it can
		// read on it, so an accessible name that drops the visible word leaves the
		// button unspeakable. An ellipsis on one side and not the other breaks it.
		for (const locale of ['en', 'ja']) {
			const messages = JSON.parse(read(`../../../messages/${locale}.json`)) as Record<string, string>;
			expect(messages.admin_suggest_tags_row_saving_label).toContain(
				messages.admin_suggest_tags_row_saving_short
			);
		}
	});

	it('marks the edit link\'s pencil decorative, since the link is named for its image', () => {
		// The anchor already carries an aria-label naming the image; an icon with a
		// name of its own would be read in front of it.
		expect(backfillPage).toMatch(
			/\{#snippet editLink\([\s\S]*?<Pencil size=\{14\} aria-hidden="true" \/>/
		);
	});

	it('gives the conflict its own eyebrow, and the sentence the body text and the focus', () => {
		// A whole sentence in .tag-eyebrow renders 11px uppercase and tracked.
		expect(backfillPage).toMatch(/<p class="tag-eyebrow warn">\{m\.admin_suggest_tags_not_saved\(\)\}<\/p>/);
		expect(backfillPage).toMatch(
			/<p class="tag-panel-body" tabindex="-1" bind:this=\{statusLines\[row\.id\]\}>\s*\{m\.admin_suggest_tags_save_conflict\(\)\}/
		);
	});

	it('prints the separator in the row meta only when an artist name precedes it', () => {
		// `{' '}` rather than a bare space: Svelte trims whitespace at the block edge.
		expect(backfillPage).toMatch(/\{#if row\.artistName\}\{row\.artistName\} &middot;\{' '\}\{\/if\}\{sourceLabel\(row\.source\)\}/);
	});

	it('keeps the rating and the NSFW note in one line of row meta', () => {
		// Structural, not whitespace-exact: what matters is that the classifier's
		// rating and the note that it changes nothing here share one paragraph.
		const meta = backfillPage.match(/<p class="rowmeta">\s*\{#if rowState\.rating\}[\s\S]*?<\/p>/)?.[0];
		expect(meta, 'the suggested row has no rowmeta paragraph').toBeTruthy();
		expect(meta).toContain('class="tag-rating-note"');
		expect(meta).toContain('m.admin_suggest_tags_nsfw_note()');
	});

	it('spins the save loader with the class app.css animates', () => {
		// The keyframes and their reduced-motion guard live in app.css, so the same
		// class spins on both surfaces. That it actually animates is asserted in
		// the browser, in tests/e2e/tag-suggestions.spec.ts.
		expect(backfillPage).toMatch(
			/<LoaderCircle size=\{14\} class="tag-spin" aria-hidden="true" \/>\s*\{m\.admin_suggest_tags_row_saving_short\(\)\}/
		);
	});

	it('leaves the thumbnail alt empty, because the row heading names the image', () => {
		expect(backfillPage).toMatch(/src=\{cdnImage\(row\.thumbnailUrl \|\| row\.imageUrl, THUMB_WIDTH\)\}\s*alt=""/);
	});

	it('loads thumbnails at thumbnail width, lazily, like the other admin lists', () => {
		// A row with no thumbnail would otherwise pull the full-size original,
		// twenty times per page, before the operator has scrolled to it.
		expect(backfillPage).toMatch(
			/cdnImage\(row\.thumbnailUrl \|\| row\.imageUrl, THUMB_WIDTH\)[\s\S]{0,120}loading="lazy"\s*decoding="async"/
		);
	});

	it('does not preload the backfill list on hover from the images page', () => {
		// app.html preloads data on hover app-wide; the backfill load scans and
		// classifies every untagged image, so this link waits for the tap.
		const imagesPage = read('../../routes/admin/images/+page.svelte');
		expect(imagesPage).toMatch(/href="\/admin\/images\/suggest-tags"[^>]*data-sveltekit-preload-data="tap"/);
	});

	it('scopes the live-region and help ids per row so they stay unique', () => {
		expect(backfillPage).toMatch(/id="row-\{row\.id\}-status"/);
		expect(backfillPage).toMatch(/id="row-\{row\.id\}-help"/);
	});
});

describe('the multi-tile hint sentence', () => {
	it('adds what the extra sentence has to add, without restating the hint it follows', () => {
		// It is appended to admin_tag_suggest_hint on the upload form, so a sentence
		// about where suggestions come from would say that twice in one paragraph.
		const en = JSON.parse(read('../../../messages/en.json')) as Record<string, string>;
		expect(en.admin_tag_suggest_hint_first_tile).toBe(
			'Accepted tags apply to every image in this upload.'
		);
		expect(en.admin_tag_suggest_hint_first_tile).not.toMatch(/source post/);
	});

	it('is left off the refusal, which is not a hint the batch sentence belongs on', () => {
		// In the noSource state the hint says the site cannot look this link up.
		// Appending "accepted tags apply to every image" answers a question nobody
		// asked about a lookup that never ran.
		expect(suggestions).toMatch(
			/firstTileOnly && source !== null && suggestion\.kind !== 'noSource'/
		);
	});

	it('joins the two sentences through a message, not a literal space', () => {
		// Both sentences carry their own full stop, and Japanese sets no space after
		// one: the separator is the locale's to choose.
		expect(suggestions).toMatch(/m\.admin_tag_suggest_hint_join\(\{/);
		expect(suggestions).not.toMatch(/&nbsp;\{m\.admin_tag_suggest_hint_first_tile/);
		const en = JSON.parse(read('../../../messages/en.json')) as Record<string, string>;
		const ja = JSON.parse(read('../../../messages/ja.json')) as Record<string, string>;
		expect(en.admin_tag_suggest_hint_join).toBe('{first} {second}');
		expect(ja.admin_tag_suggest_hint_join).toBe('{first}{second}');
	});
});

describe('an answer that stops being about the post in the field', () => {
	it('is compared canonically, so a harmless edit to the same URL keeps it', () => {
		// A trailing slash or a tracking parameter names the same post. Compared as
		// text, either would throw away chips the operator is in the middle of
		// choosing from.
		expect(suggestions).toMatch(/const canonical = \(url: string\) =>\s*classifySourceUrl\(url\)\?\.url \?\? null;/);
		expect(suggestions).toMatch(/canonical\(sourceUrl\) !== canonical\(asked\)/);
		expect(suggestions).toMatch(/answeredFor === null \|\| answeredFor === canonical\(sourceUrl\)/);
	});

	it('says the lookup was set aside rather than blanking the live region', () => {
		// The region last said "Reading the …". Emptied, a screen reader is left
		// with a lookup that never ends.
		expect(suggestions).toMatch(/announcement = m\.admin_tag_suggest_dropped_body\(\);/);
	});
});

describe('the backfill page\'s shared live region', () => {
	it('lets a later writer take the region back while a re-announce is mid-blank', () => {
		// The empty-save refusal calls reannounce from a synchronous use:enhance
		// callback without awaiting it. Claiming the region only after the tick
		// would let that write land on top of another row's sentence, with
		// announcedFor naming the wrong row afterwards.
		expect(backfillPage).toMatch(
			/announcedFor = id;\s*announcement = '';\s*await tick\(\);\s*if \(announcedFor !== id\) return;/
		);
	});
});
