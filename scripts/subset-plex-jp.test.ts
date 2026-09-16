import { describe, it, expect } from 'vitest';
import { reachableByOthers, venvIsCurrent } from './subset-plex-jp.mjs';

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
