import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source pins for the shared chrome's accessibility attributes. Which nav link
// is current is not pinned here: navCurrent's values are tested in
// $lib/nav.test.ts, and the rendered aria-current states on the header and
// mobile nav in tests/e2e/passport.spec.ts, 'marks the Gallery nav links as
// the current page or the current section'. The nav names are checked in
// tests/e2e/site-chrome.spec.ts.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const headerSrc = read('./Header.svelte');
const langSrc = read('./LanguageToggle.svelte');

describe('shared chrome accessibility markup', () => {
	it('marks the home page with aria-current on the header logo', () => {
		expect(headerSrc).toMatch(
			/<a\s+href="\/"\s+class="logo"\s+aria-current=\{\$page\.url\.pathname\s*===\s*'\/'\s*\?\s*'page'\s*:\s*undefined\}\s*>/
		);
	});

	// Source-level only; tests/e2e/passport.spec.ts ("rings a keyboard-focused
	// language button in the foreground colour") checks the rendered ring.
	it('gives the language buttons an inset focus ring and a pressed state beyond the fill', () => {
		const rule = (sel: string) =>
			langSrc.match(new RegExp(`\\.lang-toggle\\s+button${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
		const focus = rule(':focus-visible');
		expect(focus).toMatch(/outline:\s*2px\s+solid\s+var\(--foreground\)\s*;/);
		expect(focus).toMatch(/outline-offset:\s*-2px\s*;/);
		const active = rule('\\.active');
		expect(active).toMatch(/font-weight:\s*700/);
		expect(active).toMatch(/text-decoration:\s*underline/);
		// The end buttons round with the pill, so the inset ring follows its curve.
		const first = rule(':first-child');
		expect(first).toMatch(/border-start-start-radius:\s*var\(--radius-pill\)/);
		expect(first).toMatch(/border-end-start-radius:\s*var\(--radius-pill\)/);
		const last = rule(':last-child');
		expect(last).toMatch(/border-start-end-radius:\s*var\(--radius-pill\)/);
		expect(last).toMatch(/border-end-end-radius:\s*var\(--radius-pill\)/);
	});
});
