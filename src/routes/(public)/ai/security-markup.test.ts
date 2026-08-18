import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the /ai security section's markup (SONA-171), per the
// nav-gating-markup.test.ts precedent: nothing else executes this template, so
// deleting the whole <section> would otherwise leave every suite green while
// the page silently stops offering a reporting path. Each pin is a minimal
// discriminator fragment, not a verbatim copy of the markup.

const src = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('/ai security section markup', () => {
	it('renders the security lead as an h2.lead heading', () => {
		expect(src).toMatch(/<h2 class="lead">\{disclosure\.security\.lead\}<\/h2>/);
	});

	it('iterates the security body, emitting anchors for link segments', () => {
		// Unkeyed each on purpose (r1-03): a value key would throw
		// each_key_duplicate if the copy ever repeats a string segment.
		expect(src).toMatch(/\{#each disclosure\.security\.body as segment\}/);
		expect(src).toMatch(/<a\s+href=\{segment\.href\}/);
	});

	it('labels the link segments for screen readers when the data carries one', () => {
		expect(src).toMatch(/aria-label=\{segment\.ariaLabel\}/);
	});

	it('keeps the security section inside the default ({:else}) branch', () => {
		// A non-empty owner override replaces the WHOLE page, security section
		// included — deliberate wholesale-override semantics (the operator
		// decision is tracked on SONA-171; the machine-readable
		// /.well-known/security.txt still serves either way). The first {:else}
		// in the template is the override conditional's, so the lead sitting
		// after it pins the section to the default branch.
		const override = src.indexOf('{#if override.trim()}');
		const elseBranch = src.indexOf('{:else}');
		const lead = src.indexOf('{disclosure.security.lead}');
		expect(override).toBeGreaterThan(-1);
		expect(elseBranch).toBeGreaterThan(override);
		expect(lead).toBeGreaterThan(elseBranch);
	});
});
