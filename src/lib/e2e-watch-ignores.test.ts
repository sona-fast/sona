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
		expect(VITE_CONFIG).toMatch(
			/server:\s*\{[\s\S]*?watch:\s*\{\s*(?:\/\/[^\n]*\n\s*)*ignored:\s*\[[^\]]*'\*\*\/\.wrangler-e2e\*\/\*\*'/
		);
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
