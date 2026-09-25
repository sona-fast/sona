import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins, following the copy-command-markup.test.ts precedent: the repo has
// no component renderer under vitest, so the tag suggestion control (SONA-220)
// and its backfill page are pinned by reading the markup. Each of these is a
// rule a refactor could quietly drop.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const suggestions = read('./TagSuggestions.svelte');

const backfillPage = read('../../routes/admin/images/suggest-tags/+page.svelte');

describe('the tag suggestion live region', () => {
	it('is one element rendered on load and written into, not inserted with its text', () => {
		// A role=status element that appears WITH text already inside announces
		// nothing in NVDA or JAWS. The region is unconditional; only the string
		// inside it changes.
		expect(suggestions).toMatch(/<p class="sr-only" role="status" id=\{statusId\}>\{announcement\}<\/p>/);
		expect(backfillPage).toMatch(/<p class="sr-only" role="status">\{announcement\}<\/p>/);
	});
});

describe('the backfill rows', () => {
	it('does not preload the backfill list on hover from the images page', () => {
		// app.html preloads data on hover app-wide; the backfill load scans and
		// classifies every untagged image, so this link waits for the tap. A browser
		// test cannot see the absence — a hover that preloads nothing looks the same
		// as a hover the runtime never got around to — so the attribute is pinned here.
		const imagesPage = read('../../routes/admin/images/+page.svelte');
		expect(imagesPage).toMatch(/href="\/admin\/images\/suggest-tags"[^>]*data-sveltekit-preload-data="tap"/);
	});
});
