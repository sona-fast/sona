import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// Source-pins for the /art ref-sheet NSFW shield (SONA-18), following the
// nsfw-markup.test.ts precedent on the VR detail page: the shield is a pair of
// one-line conditions whose silent loss doesn't fail anything else — it just
// renders mature content unblurred on a public page.
const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('/art ref-sheet NSFW shield (SONA-18)', () => {
	// The overlay is only rgba(0,0,0,0.6) — the filter is what actually hides the
	// pixels, so pinning the class without the rule would let a rename ship an
	// NSFW ref sheet that is plainly legible through the overlay.
	it('backs the blurred class with a real blur rule', () => {
		expect(pageSrc).toMatch(/\.ref-sheet img\.blurred\s*\{[^}]*filter:\s*blur\(/);
	});
});

// The caption's sentence separator is a trailing space on the FIRST sentence,
// because the separator itself is locale-dependent: no markup or CSS answer is
// right in both, and putting it on the second sentence would drag it inside the
// gallery link, underline and all. Nothing else renders these keys, so a
// well-meaning trim would silently glue the sentences together — or add a space
// to a language that takes none after its full stop. Driven off the catalog
// directory so a locale added later is covered the day it lands.
describe('/art caption sentence separator (SONA-18)', () => {
	const dir = new URL('../../../../messages/', import.meta.url);
	const locales = readdirSync(dir)
		.filter((f) => f.endsWith('.json'))
		.map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(f, dir), 'utf8'))] as const);
	// Scripts that need no space between sentences. Everything else does.
	// Korean is deliberately absent: it spaces between sentences like the Latin
	// locales do, so its caption needs the trailing separator too.
	const noSeparator = new Set(['ja', 'zh', 'th']);

	it('covers every locale the repo ships', () => {
		expect(locales.length).toBeGreaterThan(0);
	});

	for (const [locale, messages] of locales) {
		it(`${locale}: separates the two caption sentences the way the script wants`, () => {
			expect(messages.art_ref_caption).toBeTypeOf('string');
			expect(messages.art_ref_caption.endsWith(' ')).toBe(!noSeparator.has(locale));
			// The second sentence never carries the separator: in the shielded
			// branch it is the link text, and a leading space would underline.
			for (const key of ['art_ref_view_full', 'art_ref_open_gallery'] as const) {
				expect(messages[key]).toBeTypeOf('string');
				expect(messages[key].startsWith(' ')).toBe(false);
			}
		});
	}
});
