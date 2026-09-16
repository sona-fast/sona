import { describe, it, expect } from 'vitest';
import { FAMILIES, OWNED_ELSEWHERE, acceptBytes, fileName, parseManifest, staleFiles } from './fetch-fonts.mjs';

// The prune is the one destructive thing this script does, and it runs over a
// directory holding three other things: Geist (hand-placed), the Japanese slices
// scripts/subset-plex-jp.mjs cuts, and the slices this script fetched last time.
// Nothing here touches the network — the decision is a function of the listing.
describe('fetch-fonts prune (SONA-181)', () => {
	const wanted = [
		'JetBrainsMono-latin.woff2',
		'JetBrainsMono-latin-ext.woff2',
		'IBMPlexSansJP-400-latin.woff2'
	];
	const listing = [
		...wanted,
		'IBMPlexSansJP-400-kana.woff2',
		'IBMPlexSansJP-700-kanji.woff2',
		'IBMPlexSansJP-300-latin.woff2',
		'Geist-Regular.woff2',
		'Geist-Medium.woff2',
		'README.md',
		'manifest.json',
		'manifest-jp.json'
	];
	const stale = staleFiles(listing, wanted);

	it('prunes a slice from a weight the families no longer ask for', () => {
		expect(stale).toEqual(['IBMPlexSansJP-300-latin.woff2']);
	});

	it('leaves the Japanese slices the subsetter owns', () => {
		expect(stale).not.toContain('IBMPlexSansJP-400-kana.woff2');
		expect(stale).not.toContain('IBMPlexSansJP-700-kanji.woff2');
		expect(OWNED_ELSEWHERE.test('IBMPlexSansJP-400-kana.woff2')).toBe(true);
	});

	it('leaves Geist alone, because app.css declares it and no family here owns the slug', () => {
		expect(stale.filter((f) => f.startsWith('Geist-'))).toEqual([]);
	});

	it('keeps the shared JetBrains Mono file, which carries no weight in its name', () => {
		expect(stale).not.toContain('JetBrainsMono-latin.woff2');
	});

	// The subsetter writes manifest-jp.json into the same directory, and only
	// binaries are ever this script's to remove.
	it('considers nothing but woff2 files', () => {
		expect(stale.every((f) => f.endsWith('.woff2'))).toBe(true);
		expect(staleFiles(['IBMPlexSansJP-manifest-jp.json'], [])).toEqual([]);
	});
});

// A manifest that fails to parse used to read as an empty one, which drops the
// baseline acceptBytes checks against — the run then records whatever bytes it
// finds as correct.
describe('fetch-fonts manifest parsing (SONA-181)', () => {
	it('returns the recorded digests', () => {
		const files = { 'Test-latin.woff2': 'a'.repeat(64) };
		expect(parseManifest(JSON.stringify({ note: 'x', files }))).toEqual(files);
	});

	it('throws on invalid JSON rather than reading as empty', () => {
		expect(() => parseManifest('{ files: ')).toThrow();
	});

	it('throws when `files` is missing', () => {
		expect(() => parseManifest('{"note":"x"}')).toThrow(/no `files` object/);
	});

	it('throws on a digest that is not 64 hex characters', () => {
		expect(() => parseManifest('{"files":{"Test-latin.woff2":"nope"}}')).toThrow(/non-sha256 digest/);
	});
});

describe('fetch-fonts file names', () => {
	it('names a per-weight slice with its weight', () => {
		expect(fileName('IBM Plex Sans JP', { weight: 400, subset: 'latin-ext' })).toBe(
			'IBMPlexSansJP-400-latin-ext.woff2'
		);
	});

	// One variable file serves every weight of the subset, so four copies under
	// four names is four identical binaries in the repo.
	it('drops the weight from a file shared across weights', () => {
		expect(fileName('JetBrains Mono', { weight: 400, subset: 'latin', shared: true })).toBe(
			'JetBrainsMono-latin.woff2'
		);
	});

	it('covers every family the themes declare', () => {
		expect(FAMILIES.map((f) => f.family)).toEqual([
			'JetBrains Mono',
			'Chakra Petch',
			'IBM Plex Sans JP'
		]);
	});
});

// Every file writeFace handles goes through acceptBytes — see its doc comment.
describe('fetch-fonts digest check on fetched bytes', () => {
	const bytes = Buffer.from('woff2 bytes');
	const digest = acceptBytes('Test-latin.woff2', bytes, { force: false, recorded: undefined });

	it('returns the digest when the manifest records nothing yet', () => {
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it('returns the digest when the bytes still hash as recorded', () => {
		expect(acceptBytes('Test-latin.woff2', bytes, { force: false, recorded: digest })).toBe(digest);
	});

	it('throws on bytes that moved under the same URL', () => {
		expect(() => acceptBytes('Test-latin.woff2', bytes, { force: false, recorded: 'a'.repeat(64) })).toThrow(
			/static\/fonts\/manifest\.json records/
		);
	});

	it('accepts the new bytes under --force, which is how an update is recorded', () => {
		expect(acceptBytes('Test-latin.woff2', bytes, { force: true, recorded: 'a'.repeat(64) })).toBe(digest);
	});
});
