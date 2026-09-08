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

	it('points at the sentence that explains its current state', () => {
		expect(suggestions).toMatch(
			/suggestion\.kind === 'applied' \? appliedId : suggestion\.kind === 'searching' \? statusId : hintId/
		);
	});
});

describe('focus after a suggestion is accepted or dismissed', () => {
	it('moves to the applied status line, which is focusable for the purpose', () => {
		expect(suggestions).toMatch(/tabindex="-1"[\s\S]{0,40}bind:this=\{statusLine\}/);
		expect(suggestions).toMatch(/await tick\(\);\n\t\tstatusLine\?\.focus\(\)/);
	});

	it('returns to the pill after Dismiss, rather than dropping to the body', () => {
		expect(suggestions).toMatch(/function dismiss\(\)[\s\S]*?pill\?\.focus\(\)/);
		expect(backfillPage).toMatch(/function dismiss\(id: number\)[\s\S]*?pills\[id\]\?\.focus\(\)/);
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
		expect(ratingNote).toMatch(/function markNsfw\(\) \{\n\t\tnsfw = true;/);
		expect(ratingNote).toMatch(/\{#if warn && !nsfw\}/);
		expect(ratingNote).not.toMatch(/rating[\s\S]{0,80}=>[\s\S]{0,40}nsfw = true/);
	});

	it('is referenced by the checkbox rather than sitting inside its label', () => {
		// Inside the label, a screen reader would read the classifier's guess as
		// part of the checkbox's own name.
		for (const page of [uploadPage, editPage]) {
			expect(page).toMatch(/name="nsfw" bind:checked=\{nsfw\} aria-describedby="tags-rating"/);
			expect(page).toMatch(/<TagRatingNote rating=\{suggestedRating\} id="tags-rating" bind:nsfw \/>/);
		}
	});
});

describe('the backfill rows', () => {
	it('name every control by its image, since the page repeats them per row', () => {
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_row_suggest\(\{ title: row\.title \}\)\}/);
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_row_save_label\(\{/);
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_row_dismiss\(\{ title: row\.title \}\)\}/);
		expect(backfillPage).toMatch(/aria-label=\{m\.admin_suggest_tags_edit_image_label\(\{ title: row\.title \}\)\}/);
	});

	it('leaves the thumbnail alt empty, because the row heading names the image', () => {
		expect(backfillPage).toMatch(/<img src=\{row\.thumbnailUrl \|\| row\.imageUrl\} alt="" \/>/);
	});

	it('scopes the live-region and help ids per row so they stay unique', () => {
		expect(backfillPage).toMatch(/id="row-\{row\.id\}-status"/);
		expect(backfillPage).toMatch(/id="row-\{row\.id\}-help"/);
	});
});
