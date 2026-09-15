#!/usr/bin/env node
/**
 * Sona subset-plex-jp — builds the Japanese slices of IBM Plex Sans JP that the
 * terracotta theme serves from static/fonts/ (SONA-181).
 *
 *   node scripts/subset-plex-jp.mjs
 *
 * Why this is separate from scripts/fetch-fonts.mjs: that script takes Google's
 * ready-made woff2 slices as they are. Google splits this family's Japanese
 * coverage across 123 unnamed slices per weight — 2.5 MiB of binaries and ~295
 * KB of unicode-range text in a stylesheet EVERY visitor downloads, whatever
 * theme they are on. Two slices per weight, cut ourselves from the upstream OFL
 * release, cost 1.26 MiB total and two @font-face blocks.
 *
 * Subsetting needs fonttools, which is Python and is deliberately not a repo
 * dependency. This script builds a throwaway virtualenv in the OS temp dir,
 * installs fonttools + brotli into it, and deletes nothing — rerunning reuses
 * it. Node stays the only thing a contributor needs installed to BUILD Sona;
 * Python is needed only to regenerate these four files, which are committed.
 *
 * The source is pinned by version AND sha256. An upstream tarball that changes
 * bytes under the same version is a supply-chain event, not a font update, so
 * the script stops rather than quietly reshaping the typeface.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../static/fonts/', import.meta.url));
const WORK_DIR = join(tmpdir(), 'sona-plex-jp-subset');

// The OFL release, from the npm registry rather than the GitHub release zip:
// same fonts under the same license, 72 MB instead of 317 MB, and the registry
// URL is immutable per version.
const SOURCE = {
	version: '3.0.0',
	url: 'https://registry.npmjs.org/@ibm/plex-sans-jp/-/plex-sans-jp-3.0.0.tgz',
	sha256: '051484321fcffecc69c3d608b739c5fe0f558b0fd1de7958d96ca360d161de7f'
};

/**
 * Weights 400 and 700 only. Each adds ~650 KB, and the terracotta body text is
 * the only thing that renders in this family; a browser asked for 500 or 600
 * picks the nearer of these two. Four weights would be 2.5 MiB, past the budget
 * this change was allowed.
 */
const WEIGHTS = [
	{ weight: 400, file: 'IBMPlexSansJP-Regular.woff2' },
	{ weight: 700, file: 'IBMPlexSansJP-Bold.woff2' }
];

/**
 * Kana, the CJK punctuation that sets Japanese text, and the fullwidth forms.
 * One contiguous list, because every Japanese sentence needs all of it — there
 * is no page that renders hiragana without also wanting 、。「」 and ！？.
 */
const KANA_UNICODES = [
	'U+3000-303F', // CJK symbols and punctuation: 、。〜「」々
	'U+3040-309F', // hiragana
	'U+30A0-30FF', // katakana
	'U+31F0-31FF', // katakana phonetic extensions
	'U+FF00-FFEF' // halfwidth and fullwidth forms: ！？ and fullwidth latin
];

/**
 * JIS X 0208 level 1 — the 2,965 kanji of everyday Japanese, ordered by reading.
 * Derived rather than bundled: JIS level 1 is exactly rows (ku) 16-47 of JIS X
 * 0208, and Python's built-in euc_jp codec maps each (row, cell) to its Unicode
 * character. So the list comes out of the standard library, with no data file to
 * go stale and no list to trust. Level 2 (rows 48-84, another 3,390 rare kanji)
 * is left out; those fall back to the reader's system font.
 */
const JIS_LEVEL1_PY = `
chars = []
for ku in range(16, 48):
    for ten in range(1, 95):
        try:
            chars.append(bytes([0xA0 + ku, 0xA0 + ten]).decode('euc_jp'))
        except UnicodeDecodeError:
            pass
open(OUT, 'w').write(''.join(chars))
print(len(chars))
`;

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts })
		.toString()
		.trim();
}

function fetchPinned() {
	const tarball = join(WORK_DIR, `plex-sans-jp-${SOURCE.version}.tgz`);
	let bytes;
	try {
		bytes = readFileSync(tarball);
	} catch {
		bytes = undefined;
	}
	if (bytes === undefined) {
		console.log(`fetching ${SOURCE.url}`);
		run('curl', ['-sSL', SOURCE.url, '-o', tarball]);
		bytes = readFileSync(tarball);
	}
	const digest = createHash('sha256').update(bytes).digest('hex');
	if (digest !== SOURCE.sha256) {
		throw new Error(
			`IBM Plex Sans JP ${SOURCE.version} hashed ${digest}, expected ${SOURCE.sha256}. The pinned tarball changed under its version — do not subset it; work out why first.`
		);
	}
	run('tar', ['xzf', tarball, '-C', WORK_DIR, 'package/fonts/complete/woff2/hinted/']);
	return join(WORK_DIR, 'package/fonts/complete/woff2/hinted');
}

/** A venv with fonttools + brotli, built once and reused. */
function pythonEnv() {
	const venv = join(WORK_DIR, 'fontenv');
	const pyftsubset = join(venv, 'bin/pyftsubset');
	try {
		statSync(pyftsubset);
		return { pyftsubset, python: join(venv, 'bin/python') };
	} catch {
		console.log(`building ${venv} (fonttools + brotli)`);
		run('python3', ['-m', 'venv', venv]);
		run(join(venv, 'bin/pip'), ['install', '--quiet', 'fonttools', 'brotli']);
		return { pyftsubset, python: join(venv, 'bin/python') };
	}
}

function main() {
	mkdirSync(WORK_DIR, { recursive: true });
	mkdirSync(OUT_DIR, { recursive: true });
	const fontsDir = fetchPinned();
	const { pyftsubset, python } = pythonEnv();

	// The kanji list goes to a file and is passed as --text-file: 2,965 code
	// points on a command line is past what an argv can carry on some systems.
	const kanjiTxt = join(WORK_DIR, 'jis-x0208-level1.txt');
	const count = run(python, ['-c', `OUT = ${JSON.stringify(kanjiTxt)}\n${JIS_LEVEL1_PY}`]);
	console.log(`JIS X 0208 level 1: ${count} kanji`);

	for (const { weight, file } of WEIGHTS) {
		const source = join(fontsDir, file);
		const slices = [
			{ name: `IBMPlexSansJP-${weight}-kana.woff2`, args: [`--unicodes=${KANA_UNICODES.join(',')}`] },
			{ name: `IBMPlexSansJP-${weight}-kanji.woff2`, args: [`--text-file=${kanjiTxt}`] }
		];
		for (const slice of slices) {
			// --layout-features='*' keeps the vertical and proportional-kana features
			// the family ships; dropping them is what makes a cheap subset look wrong
			// set rather than merely incomplete.
			run(pyftsubset, [
				source,
				'--flavor=woff2',
				'--layout-features=*',
				...slice.args,
				`--output-file=${join(OUT_DIR, slice.name)}`
			]);
			console.log(`${slice.name}\t${statSync(join(OUT_DIR, slice.name)).size} bytes`);
		}
	}

	const total = readdirSync(OUT_DIR)
		.filter((f) => /^IBMPlexSansJP-\d+-(kana|kanji)\.woff2$/.test(f))
		.reduce((sum, f) => sum + statSync(join(OUT_DIR, f)).size, 0);
	console.log(`\nJapanese slices: ${(total / 1048576).toFixed(2)} MiB`);
	return 0;
}

exit(main());
