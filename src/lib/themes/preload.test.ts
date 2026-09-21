import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	primaryLatinFontSrc,
	fontPreloadTag,
	fontPreloadLinkHeader,
	firstFamily
} from './preload.server.ts';
import { ALL_THEMES } from './all.ts';

// The preload is a second place that has to agree with the theme data about
// which file the headings render from. Nothing at runtime catches a preload that
// points at a file the page never uses: the browser fetches it, warns in the
// console that it went unused, and the visitor pays for it anyway.

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('the preloaded face matches the theme data', () => {
	const EXPECTED: Record<string, string | null> = {
		default: '/fonts/JetBrainsMono-latin.woff2',
		// Chakra Petch ships one file per weight, and headings render at 600, so the
		// 600 cut is the one to preload rather than the 400 that is declared first.
		terracotta: '/fonts/ChakraPetch-600-latin.woff2',
		petal: '/fonts/Nunito-latin.woff2',
		// Pewter declares no typography of its own, so it renders in the default
		// theme's JetBrains Mono and preloads that.
		pewter: '/fonts/JetBrainsMono-latin.woff2',
		aurora: '/fonts/JetBrainsMono-latin.woff2'
	};

	it('covers every theme in the registry', () => {
		expect(ALL_THEMES.map((t) => t.id).sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	for (const [id, src] of Object.entries(EXPECTED)) {
		it(`${id} preloads ${src}`, () => {
			expect(primaryLatinFontSrc(id)).toBe(src);
		});

		it(`${id}'s preloaded file is on disk`, () => {
			expect(readFileSync(`${repoRoot}static${src}`).length).toBeGreaterThan(0);
		});
	}

	it('falls back to the default face for an id the registry does not know', () => {
		expect(primaryLatinFontSrc('nope')).toBe(EXPECTED.default);
	});

	// Every src goes into an href and into a Link response header without being
	// escaped on the way. A quote would close the attribute, a comma would split
	// the header into two links, and a newline would end it. The registry is
	// repo data rather than input, so the guard is that nothing but a plain file
	// name under /fonts/ can ever be written there.
	it('every face src is a plain /fonts/ file name', () => {
		const srcs = ALL_THEMES.flatMap((t) => (t.fonts?.faces ?? []).map((f) => f.src));
		expect(srcs.length, 'no theme declares a face, so this asserts nothing').toBeGreaterThan(0);
		for (const src of srcs) {
			expect(src, `${src} is not a plain /fonts/*.woff2 path`).toMatch(
				/^\/fonts\/[A-Za-z0-9._-]+\.woff2$/
			);
		}
	});
});

describe('the preload tag', () => {
	const tag = fontPreloadTag('petal');

	it('declares the font type and CORS mode the fetch needs', () => {
		expect(tag).toContain('rel="preload"');
		expect(tag).toContain('as="font"');
		expect(tag).toContain('type="font/woff2"');
		// Without crossorigin the preloaded file is fetched a second time by the
		// @font-face rule rather than reused, which costs more than no preload.
		expect(tag).toContain('crossorigin');
		expect(tag).toContain('href="/fonts/Nunito-latin.woff2"');
	});

	it('is same-origin, so the CSP needs no new font-src entry', () => {
		expect(tag).toMatch(/href="\/fonts\//);
		expect(readFileSync(`${repoRoot}svelte.config.js`, 'utf8')).toContain(
			"'font-src': ['self']"
		);
	});
});

describe('the first family in a font-family list', () => {
	it('reads a single-quoted name', () => {
		expect(firstFamily("'Chakra Petch', sans-serif")).toBe('Chakra Petch');
	});

	it('reads a double-quoted name', () => {
		expect(firstFamily('"Chakra Petch", sans-serif')).toBe('Chakra Petch');
	});

	it('reads an unquoted name', () => {
		expect(firstFamily('Chakra Petch, sans-serif')).toBe('Chakra Petch');
	});

	it('is null for an empty list', () => {
		expect(firstFamily('')).toBe(null);
	});
});

describe('the preload Link header', () => {
	it('names the same file as the tag, in Link syntax', () => {
		expect(fontPreloadLinkHeader('petal')).toBe(
			'</fonts/Nunito-latin.woff2>; rel=preload; as=font; type=font/woff2; crossorigin'
		);
	});

	it('falls back to the default face for an id the registry does not know', () => {
		expect(fontPreloadLinkHeader('nope')).toContain('/fonts/JetBrainsMono-latin.woff2');
	});
});

describe('app.html declares the placeholder the hook fills', () => {
	it('carries %preload%', () => {
		expect(readFileSync(`${repoRoot}src/app.html`, 'utf8')).toContain('%preload%');
	});
});
