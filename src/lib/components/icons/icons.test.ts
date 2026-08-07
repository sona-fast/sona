import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The social icons are decorative: the platform they stand for has to reach the
// accessibility tree as text, from the element around them. Left exposed, each
// one is instead an unlabeled graphic a screen reader announces on its own, and
// in IE/older engines an inline <svg> is also a tab stop — hence
// focusable="false" alongside.
//
// Hiding them is only safe where that surrounding text exists, and it did not
// everywhere. Three shapes wrap an icon in something with no text of its own —
// an anchor, a form-field label, and the mobile artist-row badge — so the
// describes below scan for each and require a name on it.
//
// Source scan rather than a render test: these are static markup files with no
// props affecting the root element, and the repo's vitest setup is pure-TS
// (see vitest.config.ts), so compiling Svelte components here would buy nothing.

const iconsDir = fileURLToPath(new URL('.', import.meta.url));
const icons = readdirSync(iconsDir)
	.filter((f) => f.endsWith('.svelte'))
	.sort();
const componentNames = icons.map((f) => f.replace(/\.svelte$/, ''));

// Every .svelte file in src, read once and shared by every describe below.
const srcDir = new URL('../../../', import.meta.url);
const sources = new Map(
	readdirSync(fileURLToPath(srcDir), { recursive: true })
		.map((p) => String(p))
		.filter((p) => p.endsWith('.svelte'))
		.sort()
		.map((rel) => [rel, readFileSync(new URL(rel, srcDir), 'utf8')])
);

// Matched on the class token, not a literal `class="sr-only"`: a restyle that
// switches quote style or adds a second class must not silently drop the checks
// below to zero.
const SR_ONLY_SPAN_OPEN = /<span[^>]*class=["'][^"']*\bsr-only\b/;
const SR_ONLY_SPAN = new RegExp(`${SR_ONLY_SPAN_OPEN.source}[^>]*>[\\s\\S]*?</span>`, 'g');

// What a screen reader is left with inside a wrapper: drop the icons (aria-hidden)
// and any visually-hidden text (which IS the name, checked for separately). An
// empty remainder means the wrapper has nothing to announce on its own.
function announceableText(inner: string): string {
	return componentNames
		.reduce((acc, name) => acc.replaceAll(new RegExp(`<${name}\\b[^>]*/>`, 'g'), ''), inner)
		.replaceAll(SR_ONLY_SPAN, '')
		.trim();
}

const hasSrOnly = (inner: string) => SR_ONLY_SPAN_OPEN.test(inner);

// A wrapper is named either by aria-label/aria-labelledby on it or by
// visually-hidden text inside it. Returns the ones with neither.
const unnamedIn = (matched: { where: string; attrs: string; inner: string }[]) =>
	matched
		.filter(({ attrs, inner }) => !/aria-label(ledby)?=/.test(attrs) && !hasSrOnly(inner))
		.map(({ where }) => where);

describe('social icon components are decorative', () => {
	it('finds every icon component', () => {
		// Coverage floor: Bluesky, DeviantArt, FurAffinity, FurTrack, Instagram,
		// Patreon, Telegram, Twitter. A drop means the scan stopped seeing them.
		expect(icons.length).toBeGreaterThanOrEqual(8);
	});

	for (const file of icons) {
		it(`${file} hides its root svg from the accessibility tree`, () => {
			const source = readFileSync(new URL(file, import.meta.url), 'utf8');
			// The root element, not a nested one — the attributes have to be on the
			// element that gets exposed.
			const rootSvg = source.match(/<svg\b[^>]*>/)?.[0];
			expect(rootSvg, `${file} has no <svg> element`).toBeDefined();
			expect(rootSvg).toContain('aria-hidden="true"');
			expect(rootSvg).toContain('focusable="false"');
		});
	}
});

describe('nothing renders a social icon as an anchor with no accessible name', () => {
	// The counterpart to aria-hidden above. An <a> whose only content is one of
	// these icons has nothing left to announce, so it needs a name of its own —
	// either an aria-label/aria-labelledby on the anchor, or visually-hidden text
	// inside it.
	const matched = [...sources].flatMap(([rel, source]) =>
		[...source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)]
			.filter(([, , inner]) => componentNames.some((n) => inner.includes(`<${n}`)))
			.filter(([, , inner]) => announceableText(inner) === '')
			.map(([, attrs, inner]) => ({ where: `${rel}: <a${attrs}>`, attrs, inner }))
	);

	it('finds the icon-only anchors at all', () => {
		// Floor over the MATCHED anchors, labelled ones included — counting files
		// that merely mention an icon passed even when the shape scan matched
		// nothing. Currently 27: Footer (6), gallery/[slug] (7), admin/artists (7),
		// admin/characters (7).
		//
		// The /about chips are NOT covered here: they render the icon dynamically
		// (<link.icon />), so the by-name scan above cannot see them. Their
		// labelling is guarded by social-chips.test.ts instead.
		expect(matched.length).toBeGreaterThanOrEqual(21);
	});

	it('labels every one of them', () => {
		expect(unnamedIn(matched)).toEqual([]);
	});
});

describe('nothing renders a social icon as a form-field label with no accessible name', () => {
	// Same hole in the admin social inputs: <label> wrapping only an aria-hidden
	// icon and the field gives that field no accessible name at all.
	const matched = [...sources].flatMap(([rel, source]) =>
		[...source.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)]
			.filter(([, , inner]) => componentNames.some((n) => inner.includes(`<${n}`)))
			.filter(
				([, , inner]) =>
					announceableText(inner).replace(/<(?:input|select|textarea)\b[^>]*>/g, '').trim() === ''
			)
			.map(([, attrs, inner]) => ({ where: `${rel}: <label${attrs}>`, attrs, inner }))
	);

	it('finds the icon-only field labels at all', () => {
		// 7 in NewArtistDialog, 7 in admin/artists, 7 in admin/characters.
		expect(matched.length).toBeGreaterThanOrEqual(21);
	});

	it('labels every one of them', () => {
		expect(unnamedIn(matched)).toEqual([]);
	});
});

describe('nothing renders a social icon as a bare mobile badge', () => {
	// The admin artists list collapses its social column to <span
	// class="mobile-social-icon"> badges on narrow screens — icon only, so the
	// same rule applies. Matched within a line: these are written one per line,
	// and a reformat drops them out of the scan, which the floor below catches.
	const matched = [...sources].flatMap(([rel, source]) =>
		[...source.matchAll(/<span class="mobile-social-icon"([^>]*)>(.*)<\/span>/g)].map(
			([, attrs, inner]) => ({ where: `${rel}: <span class="mobile-social-icon">`, attrs, inner })
		)
	);

	it('finds the mobile social badges at all', () => {
		expect(matched.length).toBeGreaterThanOrEqual(7);
	});

	it('labels every one of them', () => {
		expect(unnamedIn(matched)).toEqual([]);
	});
});

describe('every component that uses .sr-only defines it', () => {
	// Svelte scopes styles per component, so a .sr-only class with no rule in the
	// same file is not hidden — the platform name renders as visible text next to
	// the icon. Cheaper to catch here than in a screenshot.
	it('has no component using the class without the rule', () => {
		// Element-agnostic: the class is also used on a <p> and a <div>, not only
		// on the icon-label spans SR_ONLY_SPAN_OPEN matches.
		const users = [...sources].filter(([, source]) => /class=["'][^"']*\bsr-only\b/.test(source));
		expect(users.length).toBeGreaterThanOrEqual(7);
		const undefinedRule = users
			.filter(([, source]) => !/\.sr-only\s*\{[^}]*position:\s*absolute/.test(source))
			.map(([rel]) => rel);
		expect(undefinedRule).toEqual([]);
	});
});
