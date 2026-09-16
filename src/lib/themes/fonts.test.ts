import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KANA_UNICODES, KANJI_BLOCK } from '../../../scripts/subset-plex-jp.mjs';
import { ALL_THEMES } from './all.ts';
import { SUBSET_JP_KANA, SUBSET_JP_KANJI } from './types.ts';

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

	// The same thing said about the emitted CSS. Matching lines alone would pass
	// even if a family moved into another theme's block, so the file is split into
	// its top-level blocks first and the naming is attributed to a selector.
	// @font-face is skipped: those blocks are top-level by design and name every
	// family (the describe's own opening comment says why).
	// A block may be preceded by the theme's `/* Label */` comment on its own
	// line, so the selector is the last line of the match before the brace.
	const blocks = [...generatedCss.matchAll(/^([^\s{][^{}]*)\{([^}]*)\}/gm)]
		.map(([, sel, body]) => ({ selector: sel.trim().split('\n').pop()!.trim(), body }))
		.filter((b) => !b.selector.startsWith('@'));

	it('finds every theme block in the generated CSS', () => {
		expect(blocks.map((b) => b.selector)).toEqual([
			':root',
			"[data-theme='light']",
			"[data-theme-id='aurora']",
			"[data-theme-id='aurora'][data-theme='light']",
			"[data-theme-id='terracotta']",
			"[data-theme-id='terracotta'][data-theme='light']"
		]);
	});

	it('names them only inside the terracotta blocks', () => {
		const naming = blocks
			.filter((b) =>
				b.body
					.split('\n')
					.filter((line) => /--font-(primary|secondary):/.test(line))
					.some((line) => families.some((f) => line.includes(f)))
			)
			.map((b) => b.selector);
		expect(naming).toEqual(["[data-theme-id='terracotta']"]);
	});

	it('is the terracotta dark block that carries both font tokens', () => {
		const body = blocks.find((b) => b.selector === "[data-theme-id='terracotta']")?.body ?? '';
		expect(body).toContain("--font-primary: 'Chakra Petch', 'IBM Plex Sans JP', sans-serif;");
		expect(body).toContain("--font-secondary: 'IBM Plex Sans JP', sans-serif;");
	});
});

// SONA-181 follow-up: terracotta is the akito.dog fork's theme and IBM Plex
// Sans JP is there to set Japanese. The two slices below are cut from the
// upstream OFL release by `node scripts/subset-plex-jp.mjs` rather than taken
// from Google — static/fonts/README.md says why. Nothing else in the repo would
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

	// Each slice is bound to its own range: a kana file declared over the kanji
	// block would load for every kanji and cover none of them.
	for (const face of jp) {
		it(`${face.src} declares the range its name promises`, () => {
			expect(face.unicodeRange).toBe(face.src.includes('kanji') ? SUBSET_JP_KANJI : SUBSET_JP_KANA);
		});
	}

	// The ranges are declared twice: in types.ts, which the faces use, and in the
	// subsetter, which decides what actually goes in the file. A range the CSS
	// claims and the file does not hold renders as a blank, not a fallback glyph.
	it('declares the ranges the subsetter cuts', () => {
		expect(SUBSET_JP_KANA).toBe(KANA_UNICODES.join(', '));
		expect(SUBSET_JP_KANJI).toBe(KANJI_BLOCK);
	});

	it('declares ranges that cover kana, kanji and fullwidth punctuation', () => {
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

// scripts/fetch-fonts.mjs records a sha256 per file it writes and re-checks it
// on the next run. That only catches a change made THROUGH the script; this
// catches a font file edited or replaced in the repo, where the manifest is the
// only record of what we fetched.
describe('the fetched fonts match their recorded digests (SONA-181)', () => {
	const manifest = JSON.parse(readFileSync(`${repoRoot}static/fonts/manifest.json`, 'utf8')) as {
		files: Record<string, string>;
	};

	it('records every Google-fetched file in static/fonts/', () => {
		const fetched = readdirSync(`${repoRoot}static/fonts`)
			.filter((f) => f.endsWith('.woff2') && !f.startsWith('Geist-') && !/-(kana|kanji)\./.test(f))
			.sort();
		expect(Object.keys(manifest.files).sort()).toEqual(fetched);
	});

	for (const [name, digest] of Object.entries(manifest.files)) {
		it(`${name} hashes as recorded`, () => {
			const bytes = readFileSync(`${repoRoot}static/fonts/${name}`);
			expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
		});
	}
});

// The four Japanese slices are the ones manifest.json does NOT cover: they come
// out of scripts/subset-plex-jp.mjs, not Google, and that script writes its own
// manifest for them. Without this they would be the only fonts in the directory
// nothing checks against recorded bytes.
describe('the subset Japanese slices match their recorded digests (SONA-181)', () => {
	const manifest = JSON.parse(readFileSync(`${repoRoot}static/fonts/manifest-jp.json`, 'utf8')) as {
		files: Record<string, string>;
	};

	it('records exactly the Japanese slices on disk', () => {
		const onDisk = readdirSync(`${repoRoot}static/fonts`)
			.filter((f) => /^IBMPlexSansJP-\d+-(kana|kanji)\.woff2$/.test(f))
			.sort();
		expect(Object.keys(manifest.files).sort()).toEqual(onDisk);
	});

	for (const [name, digest] of Object.entries(manifest.files)) {
		it(`${name} hashes as recorded`, () => {
			const bytes = readFileSync(`${repoRoot}static/fonts/${name}`);
			expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
		});
	}
});

// The font files are served straight off Pages under names that carry no
// content hash, so the cache rule is hand-written in the root _headers file.
// Without it they inherit the default and are revalidated far more often than
// bytes that change only when scripts/fetch-fonts.mjs runs.
describe('the fonts are cached at the edge (SONA-181)', () => {
	// Root, not static/: adapter-cloudflare throws if _headers sits in the assets
	// directory, and copies the root one into the build before appending its own
	// block for SvelteKit's hashed assets.
	const headers = readFileSync(`${repoRoot}_headers`, 'utf8');

	it('gives /fonts/* a month of caching, and no immutable', () => {
		const rule = headers.match(/^\/fonts\/\*\n((?:[ \t]+\S.*\n)+)/m)?.[1] ?? '';
		expect(rule).toContain('Cache-Control: public, max-age=2592000');
		expect(rule).not.toContain('immutable');
	});
});
