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
 * Some families are served as ONE variable file per subset shared by every
 * weight — JetBrains Mono is — so the faces are grouped by source URL and that
 * file is written once, under a name with no weight in it.
 *
 * The @font-face blocks themselves are emitted by scripts/build-themes.ts from
 * the `faces` arrays in src/lib/themes/*.theme.ts — this script only puts the
 * binaries where those arrays say they are. Run it when a theme adds a family or
 * a weight; the files are committed, so a normal build never needs it.
 *
 * Every file's sha256 is recorded in static/fonts/manifest.json and re-checked
 * on the next run, so a binary that changes bytes under the same URL is a stop,
 * not a silent typeface swap.
 *
 * No new dependency: fetch, node:crypto and node:fs only.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../static/fonts/', import.meta.url));
const MANIFEST_PATH = `${OUT_DIR}manifest.json`;

// Chrome's UA string. Google's CSS2 API decides the format from it: an older or
// unknown agent gets ttf or woff, which is 2-3× the bytes for the same glyphs.
const CHROME_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// The stylesheet names where the binaries live. Anything else in a src: url() is
// a redirected or tampered stylesheet, so the fetch stops rather than writing a
// file of unknown origin into static/fonts/.
const BINARY_ORIGIN = 'https://fonts.gstatic.com/';

// Files in static/fonts/ that another script writes. They share a family slug
// with something below, so the prune has to be told to leave them alone.
export const OWNED_ELSEWHERE = /^IBMPlexSansJP-\d+-(kana|kanji)\.woff2$/;

/**
 * The families each theme names, with the weights its CSS asks for, and the
 * Google subset slices to keep for each.
 *
 * IBM Plex Sans JP takes its LATIN slices from here and its Japanese coverage
 * from scripts/subset-plex-jp.mjs — static/fonts/README.md says why. Run both
 * scripts when this family changes.
 */
export const FAMILIES = [
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
 * block. The CJK slices carry no comment and this script never wants them (see
 * static/fonts/README.md), so an unnamed block is skipped.
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
		if (!weight || !url || named === undefined) continue;
		faces.push({ subset: named, weight: Number(weight), style, url, unicodeRange });
	}
	return faces;
}

/**
 * `IBM Plex Sans JP` + `latin-ext` → `IBMPlexSansJP-400-latin-ext.woff2`.
 *
 * `shared` means one variable file covers every weight of this subset, so the
 * name carries no weight: `JetBrainsMono-latin.woff2`.
 */
export function fileName(family, { weight, subset, shared }) {
	const slug = family.replace(/[^A-Za-z0-9]/g, '');
	const sub = subset.replace(/[^A-Za-z0-9-]/g, '-');
	return shared ? `${slug}-${sub}.woff2` : `${slug}-${weight}-${sub}.woff2`;
}

/**
 * The prune decision, as a function of the directory listing and the names this
 * run wants. A dropped weight or subset leaves a binary nothing references, but
 * only files whose name starts with a slug this script manages are its to
 * remove: Geist is hand-placed and declared in app.css, and OWNED_ELSEWHERE is
 * the Japanese slices scripts/subset-plex-jp.mjs cuts into the same directory.
 * Binaries only — the two manifests, the README and OFL.txt are never candidates.
 */
export function staleFiles(existing, wanted) {
	const keep = new Set(wanted);
	const slugs = FAMILIES.map(({ family }) => family.replace(/[^A-Za-z0-9]/g, '') + '-');
	return [...existing].filter(
		(name) =>
			name.endsWith('.woff2') &&
			!keep.has(name) &&
			!OWNED_ELSEWHERE.test(name) &&
			slugs.some((s) => name.startsWith(s))
	);
}

/**
 * The (weight, subset) pairs an entry asks for that the CSS2 response did not
 * carry. A partial response used to pass as long as one face matched; the prune
 * then removed the missing slice's committed file and the theme CSS pointed at
 * nothing. Every requested pair has to be there before anything is written.
 */
export function missingFaces(entry, faces) {
	return entry.weights.flatMap((weight) =>
		entry.subsets
			.filter((subset) => !faces.some((f) => f.weight === weight && f.subset === subset))
			.map((subset) => `${weight}/${subset}`)
	);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The recorded digests, from the manifest's text. Throws on anything that is not
 * the shape this script writes: a manifest that failed to parse used to read as
 * an empty one, which silently drops the baseline every later run checks against
 * — exactly the case the digests exist to catch.
 */
export function parseManifest(text) {
	const parsed = JSON.parse(text);
	const files = parsed?.files;
	if (files === null || typeof files !== 'object' || Array.isArray(files)) {
		throw new Error('static/fonts/manifest.json has no `files` object');
	}
	for (const [name, digest] of Object.entries(files)) {
		if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
			throw new Error(`static/fonts/manifest.json records a non-sha256 digest for ${name}`);
		}
	}
	return files;
}

/**
 * Only a missing manifest is an empty baseline: that is the first run. Anything
 * else propagates, so a corrupt or unreadable file stops the run instead of
 * resetting it. The path is a parameter so the test can point it at a temp dir.
 */
export function readManifest(path = MANIFEST_PATH) {
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') return { present: false, files: {} };
		throw err;
	}
	return { present: true, files: parseManifest(text) };
}

/**
 * Returns the sha256 of the bytes just fetched or read from disk. Throws if they
 * are not the bytes the manifest records. Every file goes through here on every
 * run: a file already on disk is checked as it is read, and a fetched file is
 * checked BEFORE it is written, so a re-cut upstream file leaves the committed
 * woff2 alone instead of overwriting it and then failing. --force is how you
 * accept a genuine upstream update.
 */
export function acceptBytes(name, bytes, { force, recorded }) {
	const digest = sha256(bytes);
	if (!force && recorded !== undefined && recorded !== digest) {
		throw new Error(
			`${name} hashed ${digest}, but static/fonts/manifest.json records ${recorded}. Work out why before accepting it; re-run with --force to record the new bytes.`
		);
	}
	return digest;
}

/**
 * A file already on disk, checked against the manifest the same way fetched
 * bytes are, with one more rule: when a manifest exists and does not name the
 * file, the file is refused. A fetched file with no entry is a new face; a file
 * that is already here with no entry is a manifest that lost its line, and
 * accepting it would record whatever bytes are there as the baseline.
 */
export function acceptCached(name, bytes, { force, recorded, present }) {
	if (!force && present && recorded === undefined) {
		throw new Error(
			`${name} is in static/fonts/ but static/fonts/manifest.json does not record it. Remove the file to fetch it again, or re-run with --force to record the bytes on disk.`
		);
	}
	return acceptBytes(name, bytes, { force, recorded });
}

/** One face's binary, fetched or taken from disk. */
async function writeFace(name, url, { force, recorded, present }) {
	// Already on disk and not re-fetched: checked against the manifest too, so an
	// edited file cannot record its own digest. See acceptCached and acceptBytes.
	refuseSymlink(OUT_DIR + name);
	if (!force && existsOnDisk(name)) {
		const onDisk = readFileSync(OUT_DIR + name);
		return { bytes: onDisk.length, sha256: acceptCached(name, onDisk, { force, recorded, present }) };
	}
	if (!url.startsWith(BINARY_ORIGIN)) {
		throw new Error(`${name}: ${url} is not on ${BINARY_ORIGIN} — refusing to fetch it`);
	}
	const res = await fetch(url, { headers: { 'user-agent': CHROME_UA } });
	if (!res.ok) throw new Error(`${name}: ${res.status} fetching ${url}`);
	const bytes = Buffer.from(await res.arrayBuffer());
	const digest = acceptBytes(name, bytes, { force, recorded });
	// Through a .part file and a rename, so an interrupted write cannot leave a
	// truncated font under the committed name.
	writeFileSync(`${OUT_DIR + name}.part`, bytes);
	renameSync(`${OUT_DIR + name}.part`, OUT_DIR + name);
	return { bytes: bytes.length, sha256: digest };
}

/**
 * A symlink at a managed font path would make a read or write land wherever it
 * points, so it is refused before either. A missing entry is fine: that is the
 * fetch case. Exported so the test can point it at a temp dir.
 */
export function refuseSymlink(path) {
	let st;
	try {
		st = lstatSync(path);
	} catch (err) {
		if (err.code === 'ENOENT') return;
		throw err;
	}
	if (st.isSymbolicLink()) {
		throw new Error(`${path} is a symlink, not a font file — remove it and rerun`);
	}
}

function existsOnDisk(name) {
	try {
		return statSync(OUT_DIR + name).size > 0;
	} catch {
		return false;
	}
}

async function main() {
	const force = argv.includes('--force');
	mkdirSync(OUT_DIR, { recursive: true });
	const existing = readdirSync(OUT_DIR);
	const { present, files: recorded } = readManifest();
	const manifest = [];

	for (const entry of FAMILIES) {
		const res = await fetch(cssUrl(entry), { headers: { 'user-agent': CHROME_UA } });
		if (!res.ok) throw new Error(`${entry.family}: CSS2 API returned ${res.status}`);
		const css = await res.text();
		const faces = parseFaces(css).filter(
			(f) => entry.weights.includes(f.weight) && entry.subsets.includes(f.subset)
		);
		const missing = missingFaces(entry, faces);
		if (missing.length > 0) {
			throw new Error(`${entry.family}: the CSS2 response has no @font-face for ${missing.join(', ')}`);
		}

		// One file per distinct URL. A variable family serves every weight from the
		// same URL, and writing it once per weight put four byte-identical copies of
		// JetBrains Mono in the repo.
		const byUrl = new Map();
		for (const face of faces) {
			const group = byUrl.get(face.url);
			if (group) group.weights.push(face.weight);
			else byUrl.set(face.url, { ...face, weights: [face.weight] });
		}

		for (const face of byUrl.values()) {
			const shared = face.weights.length > 1;
			const name = fileName(entry.family, { ...face, shared });
			const written = await writeFace(name, face.url, { force, recorded: recorded[name], present });
			manifest.push({ ...face, family: entry.family, name, shared, ...written });
		}
	}

	for (const name of staleFiles(existing, manifest.map((f) => f.name))) {
		rmSync(OUT_DIR + name);
		console.log(`removed stale ${name}`);
	}

	// The digests are written; the face list is not. The authoritative list of
	// faces is the `faces` array in each theme file, and a second generated list
	// would be a second thing to keep in sync.
	const files = {};
	for (const f of [...manifest].sort((a, b) => a.name.localeCompare(b.name))) files[f.name] = f.sha256;
	writeFileSync(
		MANIFEST_PATH,
		`${JSON.stringify(
			{
				note: 'sha256 of every file scripts/fetch-fonts.mjs writes into this directory. Each run checks every file against it and stops on a mismatch; see the script.',
				files
			},
			undefined,
			'\t'
		)}\n`
	);

	let total = 0;
	for (const f of manifest) {
		total += f.bytes;
		const weights = f.shared ? `${f.weights.join('/')} (one variable file)` : f.weight;
		console.log(`${f.name}\t${weights}\t${f.subset}\t${f.bytes} bytes`);
		if (f.unicodeRange) console.log(`\tunicode-range: ${f.unicodeRange}`);
	}
	console.log(`\n${manifest.length} files, ${(total / 1024).toFixed(1)} KiB total`);
	return 0;
}

// Only run when invoked directly, so the unit tests can import the helpers above
// without fetching anything. Realpaths, for the same reason build-themes.ts
// compares them: a symlinked checkout makes the two spellings differ.
if (argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv[1])) {
	exit(await main());
}
