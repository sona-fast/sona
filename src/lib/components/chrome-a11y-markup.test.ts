import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source pins for the shared chrome's accessibility attributes. The unit suite
// renders no Svelte components, and a dropped attribute fails silently: the
// page still looks right, but a screen reader loses which page is current or
// which nav is which.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const headerSrc = read('./Header.svelte');
const mobileNavSrc = read('./MobileNav.svelte');
const langSrc = read('./LanguageToggle.svelte');

describe('shared chrome accessibility markup', () => {
	it('marks the current page with aria-current on the mobile tab, the header logo and the header links', () => {
		// "page" only on an exact match; a page further down the section (a piece
		// under /gallery) gets "true", so it is not announced as the Gallery page.
		expect(mobileNavSrc).toMatch(
			/aria-current=\{\$page\.url\.pathname\s*===\s*tab\.href\s*\?\s*'page'\s*:\s*active\s*\?\s*'true'\s*:\s*undefined\}/
		);
		expect(mobileNavSrc).toMatch(/\{@const\s+active\s*=\s*isActive\(tab\.href,\s*\$page\.url\.pathname\)\}/);
		expect(headerSrc).toMatch(
			/<a\s+href="\/"\s+class="logo"\s+aria-current=\{\$page\.url\.pathname\s*===\s*'\/'\s*\?\s*'page'\s*:\s*undefined\}\s*>/
		);
		expect(headerSrc).toMatch(/\{@const\s+active\s*=\s*\$page\.url\.pathname\.startsWith\(item\.href\)\}/);
		expect(headerSrc).toMatch(
			/<a\s+href=\{item\.href\}\s+class="nav-link"\s+class:active\s+aria-current=\{\$page\.url\.pathname\s*===\s*item\.href\s*\?\s*'page'\s*:\s*active\s*\?\s*'true'\s*:\s*undefined\}/
		);
		// No link may claim "page" from a prefix match alone.
		expect(headerSrc).not.toMatch(/aria-current=\{active\s*\?\s*'page'/);
		expect(mobileNavSrc).not.toMatch(/aria-current=\{active\s*\?\s*'page'/);
	});

	it('names both main navs through the message catalog', () => {
		expect(headerSrc).toMatch(/<nav\s+aria-label=\{m\.nav_main_label\(\)\}\s*>/);
		expect(mobileNavSrc).toMatch(/<nav\s+class="mobile-nav"\s+aria-label=\{m\.nav_main_label\(\)\}\s*>/);
	});

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
