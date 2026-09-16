import { describe, it, expect } from 'vitest';
import { reachableByOthers, venvIsCurrent, workDirProblem } from './subset-plex-jp.mjs';

// The work dir sits in the shared OS temp dir, so the mode rule is the thing
// keeping another user's tarball or venv out of the build. Importing the module
// builds nothing: its main() is behind a realpath argv check.
describe('subset-plex-jp work-dir mode (SONA-181)', () => {
	it('accepts a directory only its owner can reach', () => {
		expect(reachableByOthers(0o700)).toBe(false);
		expect(reachableByOthers(0o500)).toBe(false);
	});

	it('rejects any group or other bit, not only write', () => {
		expect(reachableByOthers(0o755)).toBe(true);
		expect(reachableByOthers(0o750)).toBe(true);
		expect(reachableByOthers(0o707)).toBe(true);
	});
});

// prepareWorkDir builds its error message from this predicate, which is where
// every reason to refuse the temp directory lives. The directory itself is only
// reachable at module load, so the decision is tested here rather than through
// the filesystem.
describe('subset-plex-jp work-dir predicate (SONA-181)', () => {
	const stat = (over: { symlink?: boolean; file?: boolean; uid?: number; mode?: number } = {}) => ({
		isSymbolicLink: () => over.symlink ?? false,
		isDirectory: () => !(over.symlink ?? false) && !(over.file ?? false),
		uid: over.uid ?? 501,
		mode: over.mode ?? 0o40700
	});

	it('accepts a directory you own at 0o700', () => {
		expect(workDirProblem(stat(), 501)).toBeNull();
	});

	it('rejects a symlink planted at the path', () => {
		expect(workDirProblem(stat({ symlink: true }), 501)).toMatch(/symlink/);
	});

	it('rejects a plain file left at the path', () => {
		expect(workDirProblem(stat({ file: true }), 501)).toMatch(/not a directory/);
	});

	it('rejects a directory another user owns', () => {
		expect(workDirProblem(stat({ uid: 502 }), 501)).toMatch(/uid 502/);
	});

	it('skips the owner check where there is no uid (Windows)', () => {
		expect(workDirProblem(stat({ uid: 502 }), undefined)).toBeNull();
	});

	it('rejects a mode other users can reach', () => {
		expect(workDirProblem(stat({ mode: 0o40755 }), 501)).toMatch(/other users can reach it/);
	});
});

// A venv left over from an earlier, differently pinned run is rebuilt rather
// than trusted, so the stamp has to match the requirements file we have now.
describe('subset-plex-jp venv stamp', () => {
	const want = 'a'.repeat(64);

	it('rebuilds when there is no stamp', () => {
		expect(venvIsCurrent(null, want)).toBe(false);
	});

	it('rebuilds when the stamp records other requirements', () => {
		expect(venvIsCurrent(`${'b'.repeat(64)}\n`, want)).toBe(false);
	});

	it('reuses the venv when the stamp matches', () => {
		expect(venvIsCurrent(`${want}\n`, want)).toBe(true);
	});
});
