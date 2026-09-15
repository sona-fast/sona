import { describe, it, expect } from 'vitest';
import path from 'node:path';
import config from '../../vite.config';
import {
	E2E_PERSIST_TO,
	E2E_PERSIST_TO_RECOVERY,
	E2E_PERSIST_TO_UT,
	E2E_PERSIST_TO_UPLOAD
} from '../../tests/e2e/paths';

// Read the resolved config rather than the source text: the glob only silences
// the watcher from inside server.watch.ignored, and reaching it through that
// property path is what proves it is there. The same string in a comment, in
// the fs.allow list or in a build-side option cannot satisfy this, and writing
// the array in some equivalent form still can.
const ignored = config.server?.watch?.ignored;
const globs = (Array.isArray(ignored) ? ignored : [ignored]).filter(
	(entry): entry is string => typeof entry === 'string'
);

// `**/<name>*/**`: everything the glob asks of a persist directory is in that
// middle segment, so the check below reads the segment back off the config
// instead of restating it.
const PERSIST_GLOB = '**/.wrangler-e2e*/**';
const PERSIST_PREFIX = PERSIST_GLOB.slice('**/'.length, -'*/**'.length);

// A Playwright run boots `npm run dev`, so the Vite server watching the
// checkout is the same server the specs drive. Without SONA_E2E_PERSIST_ROOT
// the throwaway miniflare state lands inside that checkout, and every D1 write
// a spec causes reads as a source edit: the page reloads mid-test and detaches
// whatever element the spec was about to click.
describe('the dev server does not watch the e2e harness it is running under', () => {
	it('ignores the throwaway persist directories', () => {
		expect(globs).toContain(PERSIST_GLOB);
	});

	it('ignores the Playwright output directories', () => {
		expect(globs).toContain('**/playwright-report/**');
		expect(globs).toContain('**/playwright/.cache/**');
	});

	// The two files have to agree on the directory names or the ignore silently
	// stops covering them.
	it('names every persist directory the glob has to cover', () => {
		const roots = [
			E2E_PERSIST_TO,
			E2E_PERSIST_TO_RECOVERY,
			E2E_PERSIST_TO_UT,
			E2E_PERSIST_TO_UPLOAD
		];
		expect(new Set(roots).size).toBe(roots.length);
		for (const root of roots) {
			expect(path.basename(root).startsWith(PERSIST_PREFIX)).toBe(true);
		}
	});

	// Vite's own defaults already cover .git, node_modules, the cache dir and
	// test-results, and it appends this list to them rather than replacing it.
	// Repeating those here would read as though the ignore depended on them.
	it('does not repeat the defaults Vite already applies', () => {
		for (const covered of ['**/node_modules/**', '**/test-results/**', '**/.git/**']) {
			expect(globs).not.toContain(covered);
		}
	});
});
