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
	it('marks the current page with aria-current on the mobile tab and the header logo', () => {
		expect(mobileNavSrc).toMatch(/aria-current=\{active \? 'page' : undefined\}/);
		expect(mobileNavSrc).toMatch(/\{@const active = isActive\(tab\.href, \$page\.url\.pathname\)\}/);
		expect(headerSrc).toMatch(
			/<a href="\/" class="logo" aria-current=\{\$page\.url\.pathname === '\/' \? 'page' : undefined\}>/
		);
	});

	it('names both main navs through the message catalog', () => {
		expect(headerSrc).toContain('<nav aria-label={m.nav_main_label()}>');
		expect(mobileNavSrc).toContain('<nav class="mobile-nav" aria-label={m.nav_main_label()}>');
	});

	it('gives the language buttons an inset focus ring and a pressed state beyond the fill', () => {
		expect(langSrc).toMatch(
			/\.lang-toggle button:focus-visible\s*\{\s*outline:\s*2px solid var\(--foreground\);\s*outline-offset:\s*-2px;/
		);
		const active = langSrc.match(/\.lang-toggle button\.active\s*\{([^}]*)\}/)?.[1] ?? '';
		expect(active).toMatch(/font-weight:\s*700/);
		expect(active).toMatch(/text-decoration:\s*underline/);
	});
});
