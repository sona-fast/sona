import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_THEMES } from './all.ts';

// SONA-181 moved the typefaces off Google's CDN and into static/fonts/. Three
// things have to stay true for that to hold, and each fails silently otherwise:
// nothing reaches back out to Google, every @font-face points at a file that is
// actually there, and the terracotta families stay scoped to terracotta.

const srcRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const generatedCss = readFileSync(new URL('./generated.css', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');

describe('no page reaches Google for a stylesheet or a font (SONA-181)', () => {
	// The hostnames are assembled rather than written out, so this file is not
	// itself a hit for the scan it performs.
	const GOOGLE = ['fonts.google' + 'apis.com', 'fonts.gsta' + 'tic.com'];

	// Test files are excluded: a test that pins the ABSENCE of an origin has to
	// name it. Everything else under src/ ships.
	const shipped = readdirSync(srcRoot, { recursive: true })
		.map(String)
		.filter((p) => !p.includes('/paraglide/'))
		.filter((p) => /\.(svelte|css|ts|js|html)$/.test(p))
		.filter((p) => !p.endsWith('.test.ts'))
		.map((p) => `${srcRoot}${p}`)
		.filter((p) => statSync(p).isFile());

	for (const host of GOOGLE) {
		it(`src/ names no ${host} reference`, () => {
			const offenders = shipped
				.filter((f) => readFileSync(f, 'utf8').includes(host))
				.map((f) => f.slice(srcRoot.length));
			expect(
				offenders,
				`${host} is a third-party request on every page load, and the privacy policy no longer discloses it. Self-host the file under static/fonts/ instead.`
			).toEqual([]);
		});

		it(`the CSP names no ${host} origin`, () => {
			expect(readFileSync(`${repoRoot}svelte.config.js`, 'utf8')).not.toContain(host);
		});
	}

	// The root stylesheet is app.css plus the generated file it imports; an
	// @import url(...) in either would pull a stylesheet over the network at
	// parse time, which is exactly what this change removed.
	it('imports no external stylesheet', () => {
		for (const [name, css] of [
			['app.css', appCss],
			['generated.css', generatedCss]
		] as const) {
			expect([...css.matchAll(/^@import\s+([^;]+);/gm)].map((m) => `${name}: ${m[1]}`)).toEqual(
				name === 'app.css' ? ["app.css: './lib/themes/generated.css'"] : []
			);
		}
	});
});

describe('every @font-face points at a real file (SONA-181)', () => {
	const srcs = [...generatedCss.matchAll(/src:\s*url\('([^']+)'\)/g)].map((m) => m[1]);
	const appSrcs = [...appCss.matchAll(/src:\s*url\('([^']+)'\)/g)].map((m) => m[1]);

	it('finds the faces the themes declare', () => {
		const declared = ALL_THEMES.flatMap((t) => t.fonts?.faces ?? []).map((f) => f.src);
		expect(srcs).toEqual(declared);
		expect(declared.length).toBeGreaterThan(0);
	});

	// A missing or truncated file renders as valid CSS the browser quietly falls
	// back from, so the page just wears the wrong typeface with nothing logged.
	for (const src of [...new Set([...srcs, ...appSrcs])]) {
		it(`${src} exists and is not empty`, () => {
			expect(src.startsWith('/fonts/'), `${src} is not served from static/fonts/`).toBe(true);
			const onDisk = `${repoRoot}static${src}`;
			expect(statSync(onDisk).size).toBeGreaterThan(0);
		});
	}

	it('declares font-display: swap on every face', () => {
		const blocks = generatedCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
		expect(blocks.length).toBe(srcs.length);
		expect(blocks.filter((b) => !b.includes('font-display: swap'))).toEqual([]);
	});
});

// The @font-face blocks are top-level, so every theme's faces are parsed on
// every page. What keeps an unselected theme's files from being DOWNLOADED is
// that only its own block names those families — so no other theme's
// font-family list may mention them.
describe('terracotta font families stay scoped to terracotta (SONA-181)', () => {
	const terracotta = ALL_THEMES.find((t) => t.id === 'terracotta');
	const families = [...new Set((terracotta?.fonts?.faces ?? []).map((f) => f.family))];

	it('has terracotta faces to check', () => {
		expect(families).toEqual(['Chakra Petch', 'IBM Plex Sans JP']);
	});

	for (const other of ALL_THEMES.filter((t) => t.id !== 'terracotta')) {
		it(`${other.id} names none of them in its font tokens`, () => {
			const lists = [other.fonts?.primary ?? '', other.fonts?.secondary ?? ''].join(' ');
			expect(families.filter((f) => lists.includes(f))).toEqual([]);
		});
	}

	// The same thing said about the emitted CSS: the families appear only inside
	// the terracotta block's --font-primary/--font-secondary declarations.
	it('names them only under [data-theme-id=terracotta] in the generated CSS', () => {
		const tokenLines = generatedCss
			.split('\n')
			.filter((line) => /--font-(primary|secondary):/.test(line));
		const naming = tokenLines.filter((line) => families.some((f) => line.includes(f)));
		expect(naming).toEqual([
			"\t--font-primary: 'Chakra Petch', sans-serif;",
			"\t--font-secondary: 'IBM Plex Sans JP', sans-serif;"
		]);
	});
});

// SONA-181 follow-up: terracotta is the akito.dog fork's theme and IBM Plex
// Sans JP is there to set Japanese. Google serves that coverage as 123 unnamed
// slices per weight, so the two slices below are cut from the upstream OFL
// release by `node scripts/subset-plex-jp.mjs`. Nothing else in the repo would
// notice if they went missing — the Latin faces would still resolve and
// Japanese would quietly fall back to the reader's system font — so the
// coverage is asserted here rather than left to a screenshot.
describe('terracotta sets Japanese in IBM Plex Sans JP (SONA-181)', () => {
	const jp = (ALL_THEMES.find((t) => t.id === 'terracotta')?.fonts?.faces ?? []).filter((f) =>
		/-(kana|kanji)\.woff2$/.test(f.src)
	);

	it('declares kana and kanji at the two Japanese weights', () => {
		expect(jp.map((f) => `${f.weight} ${f.src}`)).toEqual([
			'400 /fonts/IBMPlexSansJP-400-kana.woff2',
			'400 /fonts/IBMPlexSansJP-400-kanji.woff2',
			'700 /fonts/IBMPlexSansJP-700-kana.woff2',
			'700 /fonts/IBMPlexSansJP-700-kanji.woff2'
		]);
	});

	// A subset that lost a block renders as a font the browser happily uses and
	// falls back from character by character, which reads as mixed typography
	// rather than as a bug. Check the declared ranges against real text.
	const SAMPLES = 'あいうえおカタカナ漢字日本語！？、。「」';

	for (const face of jp) {
		it(`${face.src} declares a unicode-range`, () => {
			expect(face.unicodeRange).toBeTruthy();
		});
	}

	it('covers kana, kanji and fullwidth punctuation across the declared ranges', () => {
		const ranges = jp.flatMap((f) =>
			(f.unicodeRange ?? '').split(',').map((part) => {
				const [lo, hi] = part.trim().replace(/U\+/g, '').split('-');
				return [parseInt(lo, 16), parseInt(hi ?? lo, 16)] as const;
			})
		);
		const uncovered = [...SAMPLES].filter(
			(ch) => !ranges.some(([lo, hi]) => ch.codePointAt(0)! >= lo && ch.codePointAt(0)! <= hi)
		);
		expect(uncovered, `no declared face claims ${uncovered.join('')}`).toEqual([]);
	});

	// The kanji file holds JIS X 0208 level 1 (2,965 glyphs) and the kana file
	// holds kana plus CJK punctuation. Rough size floors catch a subset run that
	// produced a valid but nearly empty font — the failure mode of a bad
	// --unicodes or a --text-file that did not resolve.
	it('ships subsets big enough to hold what they claim', () => {
		const floors = { kana: 100_000, kanji: 300_000 };
		for (const face of jp) {
			const kind = face.src.includes('kanji') ? 'kanji' : 'kana';
			const bytes = statSync(`${repoRoot}static${face.src}`).size;
			expect(bytes, `${face.src} is ${bytes} bytes — did the subset lose its glyphs?`).toBeGreaterThan(
				floors[kind]
			);
		}
	});
});
