import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Guards the SONA-81 link affordance: content links carry a resting underline so
// they're distinguishable without relying on colour alone (WCAG 1.4.1), while UI
// chrome (buttons, nav, cards, tiles, list rows, icon-only anchors) opts out via
// its own text-decoration: none. The global rule lives in app.css; every chrome
// opt-out is component-scoped, so a global test alone can't catch a component
// that starts leaking the underline. The inventory below asserts each opt-out
// still declares `text-decoration: none`, so dropping any one fails CI.

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(srcRoot, 'app.css'), 'utf8');

// Body of a rule (text between its braces). Anchored to a line start (leading
// indentation allowed) so a plain selector can't match a compound one: `a` won't
// match a descendant `.unlocks a`, `.btn` won't match `.btn-primary`, `.back`
// won't match `.back-link`, `.social-icon` won't match `.social-icons` — the
// selector must begin its own line and be followed by whitespace or `{`.
function ruleBody(source: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const body = source.match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
	if (!body) throw new Error(`rule ${selector} not found`);
	return body;
}

describe('SONA-81 link underline affordance', () => {
	it('global content links carry a resting underline', () => {
		const rule = ruleBody(css, 'a');
		expect(rule).toMatch(/text-decoration:\s*underline\s*;/);
		expect(rule).not.toMatch(/text-decoration:\s*none\s*;/);
	});

	it('anchor-styled buttons (.btn) opt out of the underline', () => {
		// Download, pagination, and the error-page action are <a class="btn">; the
		// explicit none keeps them from inheriting the resting link underline.
		const rule = ruleBody(css, '.btn');
		expect(rule).toMatch(/text-decoration:\s*none\s*;/);
	});
});

// Every component-scoped chrome anchor that opts out of the resting underline.
// file is relative to src/; selector is the rule whose body must declare
// `text-decoration: none`. Removing an opt-out (or reverting the underline into
// a :hover-only rule) fails the matching case here.
const chromeOptOuts: Array<{ label: string; file: string; selector: string }> = [
	{ label: 'sticker-pack-form back link', file: 'lib/components/StickerPackForm.svelte', selector: '.back-link' },
	{ label: 'sticker-import back link', file: 'routes/admin/stickers/import/+page.svelte', selector: '.back-link' },
	{ label: 'gallery detail social icon', file: 'routes/(public)/gallery/[slug]/+page.svelte', selector: '.social-icon' },
	{ label: 'admin artists social icon', file: 'routes/admin/artists/+page.svelte', selector: '.social-icon' },
	{ label: 'admin characters social icon', file: 'routes/admin/characters/+page.svelte', selector: '.social-icon' },
	{ label: 'paths layout back arrow', file: 'routes/(paths)/+layout.svelte', selector: '.back' },
	{ label: 'admin collections cover (desktop)', file: 'routes/admin/collections/+page.svelte', selector: '.collection-cover' },
	{ label: 'admin collections thumb (mobile)', file: 'routes/admin/collections/+page.svelte', selector: '.mobile-collection-thumb' },
	{ label: 'admin conventions external-link icon', file: 'routes/admin/conventions/+page.svelte', selector: '.con-link' },
	{ label: 'sticker download-menu row', file: 'lib/components/DownloadMenu.svelte', selector: '.dl-list a' }
];

describe('SONA-81 chrome anchors opt out of the resting underline', () => {
	for (const { label, file, selector } of chromeOptOuts) {
		it(`${label} (${selector}) declares text-decoration: none`, () => {
			const source = readFileSync(path.join(srcRoot, file), 'utf8');
			const rule = ruleBody(source, selector);
			expect(rule).toMatch(/text-decoration:\s*none\s*;/);
		});
	}
});
