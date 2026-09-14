import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	E2E_PERSIST_TO,
	E2E_PERSIST_TO_RECOVERY,
	E2E_PERSIST_TO_UT,
	E2E_PERSIST_TO_UPLOAD
} from '../../tests/e2e/paths';

const VITE_CONFIG = readFileSync('vite.config.ts', 'utf8');

// The glob only silences the watcher from inside server.watch.ignored. The
// span between `server: {` and `watch: {` is lazy AND barred from crossing the
// server block's own closing line (`\n\t}`), so a watch block sitting after
// that close cannot satisfy the pin: the segment would have to eat the close
// to reach it. Indentation is the file's: one tab for a top-level key.
const PINNED_IGNORE =
	/server:\s*\{(?:(?!\n\t\})[\s\S])*?watch:\s*\{\s*(?:\/\/[^\n]*\n\s*)*ignored:\s*\[[^\]]*'\*\*\/\.wrangler-e2e\*\/\*\*'/;

// A Playwright run boots `npm run dev`, so the Vite server watching the
// checkout is the same server the specs drive. Without SONA_E2E_PERSIST_ROOT
// the throwaway miniflare state lands inside that checkout, and every D1 write
// a spec causes reads as a source edit: the page reloads mid-test and detaches
// whatever element the spec was about to click. The two files have to agree on
// the directory names or the ignore silently stops covering them.
describe('the dev server does not watch the e2e harness it is running under', () => {
	// Pinned to its position, not just its presence: the same string sitting in a
	// comment, in the fs.allow list, or in a build-side option reads as covered
	// while the watcher goes on reloading the page mid-spec.
	it('ignores the throwaway persist directories', () => {
		expect(VITE_CONFIG).toMatch(PINNED_IGNORE);
	});

	// Both ways the glob can leave server.watch and still read as present. The
	// pin is only worth its comment if it rejects them, so it is run against the
	// real config rewritten each way rather than against a hand-typed sample.
	it('rejects the glob moved out of the server watch block', () => {
		const ignored =
			"ignored: ['**/.wrangler-e2e*/**', '**/playwright-report/**', '**/playwright/.cache/**']";
		const watchBlock = `\t\twatch: {\n\t\t\t${ignored}\n\t\t}`;
		expect(VITE_CONFIG).toContain(watchBlock);
		const withoutWatch = VITE_CONFIG.replace(`${watchBlock}\n`, '');
		expect(withoutWatch).not.toMatch(PINNED_IGNORE);

		// Before the server block, as a root-level option: a build-side key with
		// the same name reads as covered while the dev watcher never sees it.
		expect(withoutWatch.replace('\tserver: {', `\t${ignored},\n\tserver: {`)).not.toMatch(
			PINNED_IGNORE
		);
		// After the server block, as a root-level watch: this is the one a lazy
		// span that may cross the server block's closing line would accept.
		expect(
			withoutWatch.replace('\tplugins: [', `\twatch: {\n\t\t${ignored}\n\t},\n\tplugins: [`)
		).not.toMatch(PINNED_IGNORE);
	});

	it('names every persist directory the glob has to cover', () => {
		const roots = [
			E2E_PERSIST_TO,
			E2E_PERSIST_TO_RECOVERY,
			E2E_PERSIST_TO_UT,
			E2E_PERSIST_TO_UPLOAD
		];
		expect(new Set(roots).size).toBe(roots.length);
		for (const root of roots) {
			expect(path.basename(root).startsWith('.wrangler-e2e')).toBe(true);
		}
	});

	// Vite's own defaults already cover .git, node_modules, the cache dir and
	// test-results, and it appends this list to them rather than replacing it.
	// Repeating those here would read as though the ignore depended on them.
	it('does not repeat the defaults Vite already applies', () => {
		for (const covered of ['**/node_modules/**', '**/test-results/**', '**/.git/**']) {
			expect(VITE_CONFIG).not.toContain(`'${covered}'`);
		}
	});
});
