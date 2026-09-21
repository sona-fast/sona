import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_THEMES } from './all.ts';
import { DEFAULT_THEME_ID } from './index.ts';

// SONA-181 moved the typefaces off Google's CDN and into static/fonts/. Three
// things have to stay true for that to hold, and each fails silently otherwise:
// nothing reaches back out to Google, every @font-face points at a file that is
// actually there, and a theme's own families stay scoped to that theme.

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

	// Geist is declared by hand in app.css, so the existence check below would
	// pass vacuously if that declaration went missing. One variable file over the
	// weights the app uses, not three static cuts: reverting to per-weight files
	// costs 70 KB and two extra requests on every first paint.
	it('finds the one variable Geist face app.css declares', () => {
		expect(appSrcs).toEqual(['/fonts/Geist-variable.woff2']);
	});

	it('declares Geist over a weight range rather than a single weight', () => {
		const geist = appCss.match(/@font-face\s*\{[^}]*Geist-variable[^}]*\}/)?.[0] ?? '';
		expect(geist).toMatch(/font-weight:\s*\d+\s+\d+/);
		expect(geist).toContain('font-display: swap');
	});

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
describe('a theme with its own faces keeps those families to itself (SONA-181)', () => {
	// The emitted CSS, split into its top-level blocks first: matching lines alone
	// would pass even if a family moved into another theme's block, so the naming
	// is attributed to a selector.
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
			"[data-theme-id='terracotta'][data-theme='light']",
			"[data-theme-id='petal']",
			"[data-theme-id='petal'][data-theme='light']",
			"[data-theme-id='pewter']",
			"[data-theme-id='pewter'][data-theme='light']"
		]);
	});

	// The default theme is left out: its block is `:root`, the floor every other
	// theme falls back to, so its JetBrains Mono applies wherever a theme declares
	// no font of its own. Scoping is a question about the alternates only.
	const withFaces = ALL_THEMES.filter(
		(t) => t.id !== DEFAULT_THEME_ID && (t.fonts?.faces ?? []).length > 0
	);

	// These literals are written out rather than read off the theme data on
	// purpose: a family or a token dropped from a theme has to fail here.
	const EXPECTED: Record<string, { families: string[]; tokens: string[] }> = {
		terracotta: {
			families: ['Chakra Petch', 'IBM Plex Sans JP'],
			tokens: [
				"--font-primary: 'Chakra Petch', 'IBM Plex Sans JP', sans-serif;",
				"--font-secondary: 'IBM Plex Sans JP', sans-serif;"
			]
		},
		petal: {
			families: ['Nunito'],
			tokens: ["--font-primary: 'Nunito', sans-serif;", "--font-secondary: 'Geist', sans-serif;"]
		}
	};

	// A theme that lost its `faces` array would make every assert below vacuous.
	it('finds the alternate themes that self-host a family', () => {
		expect(withFaces.map((t) => t.id)).toEqual(Object.keys(EXPECTED));
	});

	for (const theme of withFaces) {
		const families = [...new Set(theme.fonts!.faces!.map((f) => f.family))];
		const darkSelector = `[data-theme-id='${theme.id}']`;

		it(`${theme.id} declares exactly the families listed for it`, () => {
			expect(families).toEqual(EXPECTED[theme.id].families);
		});

		for (const other of ALL_THEMES.filter((t) => t.id !== theme.id)) {
			it(`${other.id} names none of ${theme.id}'s families in its font tokens`, () => {
				const lists = [other.fonts?.primary ?? '', other.fonts?.secondary ?? ''].join(' ');
				expect(families.filter((f) => lists.includes(f))).toEqual([]);
			});
		}

		it(`names them only inside the ${theme.id} blocks`, () => {
			const naming = blocks
				.filter((b) =>
					b.body
						.split('\n')
						.filter((line) => /--font-(primary|secondary):/.test(line))
						.some((line) => families.some((f) => line.includes(f)))
				)
				.map((b) => b.selector);
			expect(naming).toEqual([darkSelector]);
		});

		it(`is the ${theme.id} dark block that carries its font tokens`, () => {
			const body = blocks.find((b) => b.selector === darkSelector)?.body ?? '';
			for (const token of EXPECTED[theme.id].tokens) {
				expect(body).toContain(token);
			}
		});
	}
});

// scripts/fetch-fonts.mjs records a sha256 per file it writes and re-checks it
// on the next run. That only catches a change made THROUGH the script; this
// catches a font file edited or replaced in the repo, where the manifest is the
// only record of what we fetched.
describe('the fetched fonts match their recorded digests (SONA-181)', () => {
	const manifest = JSON.parse(readFileSync(`${repoRoot}static/fonts/manifest.json`, 'utf8')) as {
		files: Record<string, string>;
		handPlaced?: Record<string, string>;
	};

	it('records every Google-fetched file in static/fonts/', () => {
		const fetched = readdirSync(`${repoRoot}static/fonts`)
			.filter((f) => f.endsWith('.woff2') && !f.startsWith('Geist-'))
			.sort();
		expect(Object.keys(manifest.files).sort()).toEqual(fetched);
	});

	// Geist is not fetched: it comes from the vercel/geist-font GitHub release
	// and is placed by hand, so scripts/fetch-fonts.mjs never records it under
	// `files` (it rewrites that key from scratch and the entry would vanish).
	// Nothing else pins those bytes, which is what this is for.
	it('records every hand-placed file, and nothing it does not have', () => {
		const handPlaced = readdirSync(`${repoRoot}static/fonts`)
			.filter((f) => f.endsWith('.woff2') && f.startsWith('Geist-'))
			.sort();
		expect(Object.keys(manifest.handPlaced ?? {}).sort()).toEqual(handPlaced);
	});

	for (const [name, digest] of Object.entries(manifest.handPlaced ?? {})) {
		it(`${name} hashes as recorded`, () => {
			const bytes = readFileSync(`${repoRoot}static/fonts/${name}`);
			expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
		});

		it(`${name} is a real WOFF2 file`, () => {
			expect(readFileSync(`${repoRoot}static/fonts/${name}`).subarray(0, 4).toString('latin1')).toBe(
				'wOF2'
			);
		});
	}

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

// Bundling a font is a licensing obligation, and the three places that discharge
// it (NOTICE, static/fonts/README.md, and the copyright header of
// static/fonts/OFL.txt) are all hand-written. A theme that adds a family ships
// its bytes without touching any of them, and nothing else notices. This ties
// the three back to the font data, so the next family fails here until it is
// attributed.
describe('every bundled family is attributed (SONA-227)', () => {
	// Geist is not in any theme's `faces`: it is the default body font, declared by
	// hand in app.css, so it is read from there rather than assumed.
	const geist = [...appCss.matchAll(/@font-face\s*\{[^}]*font-family:\s*'([^']+)'/g)].map(
		(m) => m[1]
	);
	const families = [...new Set([...ALL_THEMES.flatMap((t) => t.fonts?.faces ?? []).map((f) => f.family), ...geist])].sort();

	// The OFL copyright line names the upstream PROJECT, which is not always the
	// family: these files are Google's Latin slices of IBM Plex Sans JP, released
	// under IBM's "Plex" Reserved Font Name line. Anything not listed is looked up
	// under its own name.
	const OFL_NAME: Record<string, string> = { 'IBM Plex Sans JP': 'Plex' };

	const notice = readFileSync(`${repoRoot}NOTICE`, 'utf8');
	const fontsReadme = readFileSync(`${repoRoot}static/fonts/README.md`, 'utf8');
	// Only the header: the license body below it is boilerplate that mentions
	// neither family, and matching it would make every assert here vacuous.
	const oflHeader = readFileSync(`${repoRoot}static/fonts/OFL.txt`, 'utf8').split(
		'This Font Software is licensed'
	)[0];

	it('finds a family to check, including the hand-declared Geist', () => {
		expect(geist).toContain('Geist');
		expect(families.length).toBeGreaterThan(1);
	});

	for (const family of families) {
		it(`${family} is named in NOTICE`, () => {
			expect(notice, `${family} ships in static/fonts/ but NOTICE does not name it`).toContain(
				family
			);
		});

		it(`${family} is named in static/fonts/README.md`, () => {
			expect(fontsReadme).toContain(family);
		});

		it(`${family} has a copyright line in the OFL.txt header`, () => {
			const name = OFL_NAME[family] ?? family;
			const lines = oflHeader
				.split('\n')
				.filter((l) => l.startsWith('Copyright') && l.includes(name));
			expect(
				lines,
				`no Copyright line in static/fonts/OFL.txt names ${name}: the license text covers every file in that directory, so each family needs one`
			).not.toEqual([]);
		});
	}
});
