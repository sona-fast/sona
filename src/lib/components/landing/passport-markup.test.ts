import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source pins for the passport markup that the unit suite can't render (it runs
// no Svelte components). The rendered page, its heading, stamp names and empty
// state are driven end to end in tests/e2e/passport.spec.ts.

const passport = readFileSync(new URL('./Passport.svelte', import.meta.url), 'utf8');
const stamp = readFileSync(new URL('./Stamp.svelte', import.meta.url), 'utf8');
const home = readFileSync(new URL('../../../routes/(public)/+page@.svelte', import.meta.url), 'utf8');

// Comments stripped: a comment explaining why --ring is avoided must not count as a use.
const styleOf = (source: string) =>
	(source.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (source: string, selector: string) => {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return styleOf(source).match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';
};

describe('passport markup', () => {
	it('loads every first-screen picture eagerly at high priority', () => {
		const imgs = [...passport.matchAll(/<img\b[\s\S]*?\/>/g)].map((m) => m[0]);
		expect(imgs.length).toBe(2);
		for (const img of imgs) {
			expect(img).toContain('loading="eager"');
			expect(img).toContain('fetchpriority="high"');
		}
	});

	it('puts no button inside the picture link: the piece page has its own NSFW gate', () => {
		expect(passport).not.toMatch(/<button\b/);
		expect(passport).toMatch(/class:blurred=\{picture\.nsfw\}/);
		expect(passport).toMatch(/<span class="gate">NSFW<\/span>/);
	});

	// 50% black measures 3.95:1 behind the label over light blurred art.
	it('lays the NSFW label on a 60% scrim', () => {
		expect(rule(passport, '.gate')).toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*0\.6\)/);
	});

	it('keeps list semantics on the unstyled stamp and social lists', () => {
		const lists = [...passport.matchAll(/<ul\b[^>]*>/g)].map((m) => m[0]);
		expect(lists.length).toBe(3);
		for (const list of lists) expect(list).toContain('role="list"');
	});

	it('renders the pronouns row only when pronouns are set, spoken once with the prefix', () => {
		expect(passport).toMatch(/\{#if passport\.pronouns\}[\s\S]*?m\.pronouns_prefix\(\)[\s\S]*?\{\/if\}/);
	});

	it('draws focus rings inside the book with --foreground, never --ring', () => {
		expect(rule(passport, '.book a:focus-visible')).toMatch(/outline:\s*2px solid var\(--foreground\)/);
		expect(rule(stamp, '.stamp:focus-visible')).toMatch(/outline:\s*2px solid var\(--foreground\)/);
		expect(styleOf(passport) + styleOf(stamp)).not.toContain('--ring');
	});

	it('gives the machine-readable line a rem floor so it never shrinks past legible', () => {
		expect(rule(passport, '.mrz')).toMatch(/font-size:\s*max\(0\.625rem,\s*min\(0\.875rem,\s*3\.05cqi\)\)/);
	});

	it('animates nothing: the stamps tilt statically and nothing transitions', () => {
		for (const source of [passport, stamp]) {
			expect(styleOf(source)).not.toMatch(/\b(animation|transition)\s*:/);
		}
		// Wide stamps tilt half as far, so stacked ones can't touch at 200% zoom.
		expect(rule(stamp, '.stamp.wide')).toMatch(/rotate\(calc\(var\(--tilt, 0deg\) \/ 2\)\)/);
	});

	it('is the homepage branch for the passport layout, with the shared chrome', () => {
		const branch = home.match(/\{:else if passport\}([\s\S]*?)\{:else\}/)?.[1] ?? '';
		expect(branch).toContain('<Passport {passport} />');
		for (const part of ['<Header', '<Footer', '<MobileCredit', '<MobileNav']) expect(branch).toContain(part);
	});
});
