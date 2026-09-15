#!/usr/bin/env node
/**
 * Sona fetch-fonts — downloads the woff2 files the themes reference into
 * static/fonts/, so the app serves its own typefaces instead of linking
 * fonts.googleapis.com (SONA-181).
 *
 *   node scripts/fetch-fonts.mjs          # fetch anything missing
 *   node scripts/fetch-fonts.mjs --force  # re-fetch everything
 *
 * Google's CSS2 endpoint serves a different stylesheet per user agent. Asking
 * for it as a modern Chrome gets woff2 with unicode-range subsets, which is the
 * format and the slicing we want: one file per (weight × subset), each with the
 * range it covers, so a browser downloads only the slices a page actually needs.
 * The @font-face blocks themselves are emitted by scripts/build-themes.ts from
 * the `faces` arrays in src/lib/themes/*.theme.ts — this script only puts the
 * binaries where those arrays say they are. Run it when a theme adds a family or
 * a weight; the files are committed, so a normal build never needs it.
 *
 * No new dependency: fetch and node:fs only.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../static/fonts/', import.meta.url));

// Chrome's UA string. Google's CSS2 API decides the format from it: an older or
// unknown agent gets ttf or woff, which is 2-3× the bytes for the same glyphs.
const CHROME_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * The families each theme names, with the weights its CSS asks for, and the
 * Google subset slices to keep for each.
 *
 * IBM Plex Sans JP takes its LATIN slices from here and its Japanese coverage
 * from scripts/subset-plex-jp.mjs. Google splits the Japanese side across 123
 * unnamed slices PER WEIGHT — 2.57 MiB of binaries and ~295 KB of unicode-range
 * text in a stylesheet every visitor downloads — where two slices cut from the
 * upstream OFL release cover the same reading in 1.26 MiB and two @font-face
 * blocks. Run both scripts when this family changes.
 */
// Files in static/fonts/ that another script writes. They share a family slug
// with something here, so the prune below has to be told to leave them alone.
const OWNED_ELSEWHERE = /^IBMPlexSansJP-\d+-(kana|kanji)\.woff2$/;

const FAMILIES = [
	{ family: 'JetBrains Mono', weights: [400, 500, 600, 700], subsets: ['latin', 'latin-ext'] },
	{ family: 'Chakra Petch', weights: [400, 500, 600, 700], subsets: ['latin', 'latin-ext', 'vietnamese'] },
	{ family: 'IBM Plex Sans JP', weights: [400, 500, 600, 700], subsets: ['latin', 'latin-ext'] }
];

/** `family=Chakra+Petch:wght@400;500;600;700` */
function cssUrl({ family, weights }) {
	const name = family.replace(/ /g, '+');
	return `https://fonts.googleapis.com/css2?family=${name}:wght@${weights.join(';')}&display=swap`;
}

/**
 * Splits a CSS2 response into its @font-face blocks.
 *
 * Google names the well-known slices with a `/* latin *\/` comment before the
 * block. The CJK slices carry NO comment — for those the only identifier is the
 * `.<n>.woff2` index in the gstatic URL, so the subset name becomes `s<n>`.
 */
function parseFaces(css) {
	const faces = [];
	const re = /(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
	let m;
	while ((m = re.exec(css)) !== null) {
		const [, named, body] = m;
		const weight = body.match(/font-weight:\s*(\d+)/)?.[1];
		const style = body.match(/font-style:\s*(\w+)/)?.[1] ?? 'normal';
		const url = body.match(/src:\s*url\(([^)]+)\)/)?.[1];
		const unicodeRange = body.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim();
		if (!weight || !url) continue;
		const subset = named ?? `s${url.match(/\.(\d+)\.woff2$/)?.[1] ?? faces.length}`;
		faces.push({ subset, weight: Number(weight), style, url, unicodeRange });
	}
	return faces;
}

/** `IBM Plex Sans JP` + `latin-ext` → `IBMPlexSansJP-400-latin-ext.woff2`. */
function fileName(family, { weight, subset }) {
	const slug = family.replace(/[^A-Za-z0-9]/g, '');
	const sub = subset.replace(/[^A-Za-z0-9-]/g, '-');
	return `${slug}-${weight}-${sub}.woff2`;
}

async function main() {
	const force = argv.includes('--force');
	mkdirSync(OUT_DIR, { recursive: true });
	const existing = new Set(readdirSync(OUT_DIR));
	const manifest = [];

	for (const entry of FAMILIES) {
		const res = await fetch(cssUrl(entry), { headers: { 'user-agent': CHROME_UA } });
		if (!res.ok) throw new Error(`${entry.family}: CSS2 API returned ${res.status}`);
		const css = await res.text();
		const faces = parseFaces(css).filter(
			(f) => entry.weights.includes(f.weight) && entry.subsets.includes(f.subset)
		);
		if (faces.length === 0) throw new Error(`${entry.family}: no @font-face matched the requested weights`);

		for (const face of faces) {
			const name = fileName(entry.family, face);
			if (!force && existing.has(name)) {
				manifest.push({ ...face, family: entry.family, name, bytes: statSync(OUT_DIR + name).size });
				continue;
			}
			const bin = await fetch(face.url, { headers: { 'user-agent': CHROME_UA } });
			if (!bin.ok) throw new Error(`${name}: ${bin.status} fetching ${face.url}`);
			const bytes = Buffer.from(await bin.arrayBuffer());
			writeFileSync(OUT_DIR + name, bytes);
			manifest.push({ ...face, family: entry.family, name, bytes: bytes.length });
		}
	}

	// Slices this script no longer wants — a dropped weight or subset — are stale
	// binaries nothing references. Only files whose name starts with a slug we
	// manage are considered, so Geist (hand-placed, declared in app.css) is safe,
	// and OWNED_ELSEWHERE keeps the prune off the Japanese slices that
	// scripts/subset-plex-jp.mjs cuts into the same directory.
	const wanted = new Set(manifest.map((f) => f.name));
	const slugs = FAMILIES.map(({ family }) => family.replace(/[^A-Za-z0-9]/g, '') + '-');
	for (const name of existing) {
		if (OWNED_ELSEWHERE.test(name)) continue;
		if (!wanted.has(name) && slugs.some((s) => name.startsWith(s))) {
			rmSync(OUT_DIR + name);
			console.log(`removed stale ${name}`);
		}
	}

	// Printed, not written: the authoritative list of faces is the `faces` array
	// in each theme file, and a second generated manifest would be a second thing
	// to keep in sync.
	let total = 0;
	for (const f of manifest) {
		total += f.bytes;
		console.log(`${f.name}\t${f.weight}\t${f.subset}\t${f.bytes} bytes`);
		if (f.unicodeRange) console.log(`\tunicode-range: ${f.unicodeRange}`);
	}
	console.log(`\n${manifest.length} files, ${(total / 1024).toFixed(1)} KiB total`);
	return 0;
}

exit(await main());
