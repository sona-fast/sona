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

	it('names the chip group from that region, and describes it with the instruction line', () => {
		expect(suggestions).toMatch(/labelledBy=\{statusId\}/);
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

	it('reads the post the field names, never a stored URL the field has moved away from', () => {
		// On the edit page the stored URL and the field can differ once the operator
		// edits it; the pill, the hint and the lookup all follow the field.
		expect(suggestions).toMatch(/requestSuggestions\(\{ sourcePostUrl: sourceUrl \}\)/);
		expect(suggestions).not.toMatch(/imageId/);
		expect(editPage).not.toMatch(/imageId=\{data\.image\.id\}/);
	});

	it('points at the sentence that explains its current state', () => {
		expect(suggestions).toMatch(
			/suggestion\.kind === 'applied' \? appliedId : suggestion\.kind === 'searching' \? statusId : hintId/
		);
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
		expect(chips).toMatch(/\{#if leftOut\.has\(tag\)\}<Plus size=\{14\} \/>\{:else\}<Check size=\{14\} \/>\{\/if\}/);
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

describe('the backfill rows', () => {
	it('name every control by its image, since the page repeats them per row', () => {
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_row_suggest\(\{ title: row\.title \}\)\}/);
		// Try again is not the same action as Suggest, so it is not named like it.
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_row_try_again\(\{ title: row\.title \}\)\}/);
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_row_save_label\(\{/);
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_row_dismiss\(\{ title: row\.title \}\)\}/);
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_edit_image_label\(\{ title: row\.title \}\)\}/);
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
		expect(backfillPage).toMatch(/saving\.has\(row\.id\)\}<LoaderCircle size=\{14\} class="tag-spin" \/>/);
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
