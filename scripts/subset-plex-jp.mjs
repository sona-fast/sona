#!/usr/bin/env node
/**
 * Sona subset-plex-jp — builds the Japanese slices of IBM Plex Sans JP that the
 * terracotta theme serves from static/fonts/ (SONA-181).
 *
 *   node scripts/subset-plex-jp.mjs
 *
 * Why this is separate from scripts/fetch-fonts.mjs: that script takes Google's
 * ready-made woff2 slices as they are, and Google's slicing of this family is a
 * bad deal — static/fonts/README.md does the arithmetic. Two slices per weight,
 * cut ourselves from the upstream OFL release, cost 1.26 MiB total and two
 * @font-face blocks.
 *
 * Subsetting needs fonttools, which is Python and is deliberately not a repo
 * dependency. This script builds a throwaway virtualenv in the OS temp dir,
 * installs the pinned, hash-checked fonttools + brotli from
 * scripts/requirements-subset.txt into it, and deletes nothing — rerunning
 * reuses it. Node stays the only thing a contributor needs installed to BUILD
 * Sona; Python is needed only to regenerate these four files, which are
 * committed.
 *
 * The source is pinned by version AND sha256. An upstream tarball that changes
 * bytes under the same version is a supply-chain event, not a font update, so
 * the script stops rather than quietly reshaping the typeface.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The default export, not named getuid: `getuid` is not an export on Windows, so
// a named import throws at module load — and this module is imported by a test.
import process, { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../static/fonts/', import.meta.url));
const WORK_DIR = join(tmpdir(), 'sona-plex-jp-subset');
const REQUIREMENTS = fileURLToPath(new URL('./requirements-subset.txt', import.meta.url));

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
 *
 * Exported because src/lib/themes/types.ts declares the SAME ranges as the
 * face's unicode-range, and a range the CSS claims but the file does not hold
 * renders as a blank rather than a fallback glyph. A test pins the two together.
 */
export const KANA_UNICODES = [
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
 *
 * KANJI_BLOCK is the CJK Unified Ideographs block every one of those kanji sits
 * in, and the range types.ts declares for this face — a rarer kanji matches the
 * face, finds no glyph and falls back per character, which is cheaper than
 * spelling 2,965 code points out in a stylesheet. The build checks the derived
 * list against it; a test checks it against the declaration.
 */
export const KANJI_BLOCK = 'U+4E00-9FFF';

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

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} [opts]
 */
function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts })
		.toString()
		.trim();
}

/**
 * Whether a mode leaves the directory reachable by anyone but its owner. What
 * the OWNER bits say does not matter, so a directory an earlier version of this
 * script created with the default mode still passes.
 * @param {number} mode
 */
export function reachableByOthers(mode) {
	return (mode & 0o077) !== 0;
}

/**
 * Why the work directory cannot be used as it stands, or `null` when it can.
 * Ours or nothing: not a symlink, same owner, and nothing group- or
 * world-accessible.
 * @param {{ isSymbolicLink(): boolean, uid: number, mode: number }} st an lstat of the path
 * @param {number | undefined} uid the current uid; undefined on Windows, which has none
 */
export function workDirProblem(st, uid) {
	if (st.isSymbolicLink()) return 'it is a symlink, not a directory';
	if (uid !== undefined && st.uid !== uid) return `it belongs to uid ${st.uid}, not you`;
	if (reachableByOthers(st.mode)) {
		return `it is mode ${(st.mode & 0o777).toString(8)}, so other users can reach it`;
	}
	return null;
}

/**
 * The work directory lives in the shared OS temp dir, so anyone on the machine
 * could have created it first and left a tarball (or a venv) there for this
 * script to trust. Create it ourselves and check what is there either way: a
 * checked existsSync followed by a create trusts a directory another user wins
 * the race to make. lstat rather than stat, because a symlink planted at this
 * path would otherwise be checked as whatever it points at.
 */
function prepareWorkDir() {
	try {
		// No `recursive`: that flag makes an existing directory a success, which is
		// the case the check below has to see.
		mkdirSync(WORK_DIR, { mode: 0o700 });
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
	}
	// getuid is POSIX-only; on Windows there is no uid to compare.
	const reason = workDirProblem(lstatSync(WORK_DIR), process.getuid?.());
	if (reason !== null) {
		throw new Error(`${WORK_DIR}: ${reason}. Remove it and rerun.`);
	}
}

/**
 * The tarball, cached between runs, and never used unless it hashes as pinned.
 * @param {string} tarball
 */
function download(tarball) {
	console.log(`fetching ${SOURCE.url}`);
	// Into a .part file, renamed only once it is whole: an interrupted curl
	// otherwise leaves a truncated tarball that the next run reads as cached.
	// --fail so an error PAGE is an error, not a 500-byte "font".
	const part = `${tarball}.part`;
	run('curl', ['-sSL', '--fail', SOURCE.url, '-o', part]);
	renameSync(part, tarball);
}

function fetchPinned() {
	const tarball = join(WORK_DIR, `plex-sans-jp-${SOURCE.version}.tgz`);
	const cached = existsSync(tarball);
	if (!cached) download(tarball);
	let digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
	// A cached file that no longer hashes is most often a half-written or stale
	// download, so replace it once before calling it a supply-chain event.
	if (cached && digest !== SOURCE.sha256) {
		console.log(`cached ${tarball} hashed ${digest}; refetching once`);
		rmSync(tarball);
		download(tarball);
		digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
	}
	if (digest !== SOURCE.sha256) {
		throw new Error(
			`IBM Plex Sans JP ${SOURCE.version} hashed ${digest}, expected ${SOURCE.sha256}. The pinned tarball changed under its version — do not subset it; work out why first.`
		);
	}
	run('tar', ['xzf', tarball, '-C', WORK_DIR, 'package/fonts/complete/woff2/hinted/']);
	return join(WORK_DIR, 'package/fonts/complete/woff2/hinted');
}

/**
 * Whether the stamp beside pyftsubset says the venv was built from the
 * requirements file we have now. `null` means no venv or no stamp at all.
 * @param {string | null} stamp contents of the stamp file
 * @param {string} want sha256 of scripts/requirements-subset.txt
 */
export function venvIsCurrent(stamp, want) {
	return stamp !== null && stamp.trim() === want;
}

/**
 * A venv with fonttools + brotli, built once and reused — but only while it was
 * built from the requirements file we have now. The stamp beside pyftsubset
 * holds the sha256 of that file, so a venv left over from an earlier, unpinned
 * version of this script is rebuilt instead of trusted forever.
 */
function pythonEnv() {
	const venv = join(WORK_DIR, 'fontenv');
	const pyftsubset = join(venv, 'bin/pyftsubset');
	const stamp = join(venv, 'bin/.requirements-sha256');
	const python = join(venv, 'bin/python');
	const want = createHash('sha256').update(readFileSync(REQUIREMENTS)).digest('hex');
	const built = existsSync(pyftsubset) && existsSync(stamp) ? readFileSync(stamp, 'utf8') : null;
	if (venvIsCurrent(built, want)) return { pyftsubset, python };

	console.log(`building ${venv} (fonttools + brotli)`);
	rmSync(venv, { recursive: true, force: true });
	run('python3', ['-m', 'venv', venv]);
	// Exact versions with hashes: the tools that reshape the fonts we ship are
	// pinned the same way the source tarball is.
	run(join(venv, 'bin/pip'), ['install', '--quiet', '--require-hashes', '-r', REQUIREMENTS]);
	writeFileSync(stamp, `${want}\n`, { mode: 0o600 });
	return { pyftsubset, python };
}

function main() {
	prepareWorkDir();
	mkdirSync(OUT_DIR, { recursive: true });
	const fontsDir = fetchPinned();
	const { pyftsubset, python } = pythonEnv();

	// The kanji list goes to a file and is passed as --text-file: 2,965 code
	// points on a command line is past what an argv can carry on some systems.
	const kanjiTxt = join(WORK_DIR, 'jis-x0208-level1.txt');
	const count = run(python, ['-c', `OUT = ${JSON.stringify(kanjiTxt)}\n${JIS_LEVEL1_PY}`]);
	console.log(`JIS X 0208 level 1: ${count} kanji`);

	// The face declares KANJI_BLOCK; a derived character outside it would be in
	// the file and unreachable from the CSS.
	const [blockLo, blockHi] = KANJI_BLOCK.replace('U+', '')
		.split('-')
		.map((h) => parseInt(h, 16));
	const outside = [...readFileSync(kanjiTxt, 'utf8')].filter((ch) => {
		const point = ch.codePointAt(0) ?? 0;
		return point < blockLo || point > blockHi;
	});
	if (outside.length > 0) {
		throw new Error(`${outside.length} derived kanji fall outside ${KANJI_BLOCK}: ${outside.join('')}`);
	}

	for (const { weight, file } of WEIGHTS) {
		const source = join(fontsDir, file);
		const slices = [
			{ name: `IBMPlexSansJP-${weight}-kana.woff2`, args: [`--unicodes=${KANA_UNICODES.join(',')}`] },
			{ name: `IBMPlexSansJP-${weight}-kanji.woff2`, args: [`--text-file=${kanjiTxt}`] }
		];
		for (const slice of slices) {
			// --layout-features='*' keeps the vertical and proportional-kana features
			// the family ships; dropping them is what makes a cheap subset look wrong
			// set rather than merely incomplete. --name-IDs+=13,14 keeps the license
			// description and URL in the file, so the OFL notice travels with the
			// binary the way the license asks, not only in static/fonts/OFL.txt.
			// Into a .part file and renamed once whole, the way download() does: the
			// output path is a committed file, and an interrupted run would otherwise
			// leave it truncated in the working tree.
			const outPath = join(OUT_DIR, slice.name);
			run(pyftsubset, [
				source,
				'--flavor=woff2',
				'--layout-features=*',
				'--name-IDs+=13,14',
				...slice.args,
				`--output-file=${outPath}.part`
			]);
			renameSync(`${outPath}.part`, outPath);
			console.log(`${slice.name}\t${statSync(join(OUT_DIR, slice.name)).size} bytes`);
		}
	}

	const total = readdirSync(OUT_DIR)
		.filter((f) => /^IBMPlexSansJP-\d+-(kana|kanji)\.woff2$/.test(f))
		.reduce((sum, f) => sum + statSync(join(OUT_DIR, f)).size, 0);
	console.log(`\nJapanese slices: ${(total / 1048576).toFixed(2)} MiB`);
	return 0;
}

// Only run when invoked directly, so a test can import the unicode lists above
// without building a virtualenv. Realpaths, for the reason build-themes.ts
// gives: a symlinked checkout makes the two spellings differ.
if (argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv[1])) {
	exit(main());
}
