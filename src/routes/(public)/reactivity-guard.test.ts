import { describe, it, expect } from 'vitest';
import { compile } from 'svelte/compiler';
import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards against the sona#73 bug class: `const { image } = data` (or any prop
// value read once at init) that goes stale on a same-route client-side nav.
// Svelte's compiler flags exactly this as `state_referenced_locally`, so we
// compile every public route page and require zero — svelte-check surfaces the
// same warning but does not fail CI.
//
// BASELINE: files that already carry warnings of this class today. They're
// excused at their current count so the guard can land now; this is a ratchet —
// drive these numbers DOWN over time, never up. See the follow-up issue.
const BASELINE: Record<string, number> = {
	'(public)/collections/[slug]/+page.svelte': 5,
	'(public)/collections/+page.svelte': 2,
	'(public)/gallery/fursuit/[id]/+page.svelte': 2,
	'(public)/gallery/+page.svelte': 3,
	'(public)/about/+page.svelte': 1
};

const routesDir = fileURLToPath(new URL('.', import.meta.url));
const pages = globSync('**/+page.svelte', { cwd: routesDir }).sort();

describe('public route pages: no stale prop reads (state_referenced_locally)', () => {
	it('finds the public route pages to check', () => {
		expect(pages.length).toBeGreaterThan(0);
	});

	for (const rel of pages) {
		const key = `(public)/${rel.split(/[/\\]/).join('/')}`;
		const allowed = BASELINE[key] ?? 0;
		it(`${key} has <= ${allowed} state_referenced_locally warning(s)`, () => {
			const src = readFileSync(new URL(rel, new URL('.', import.meta.url)), 'utf8');
			const { warnings } = compile(src, { filename: key, generate: 'client' });
			const count = warnings.filter((w) => w.code === 'state_referenced_locally').length;
			expect(count).toBeLessThanOrEqual(allowed);
		});
	}
});
