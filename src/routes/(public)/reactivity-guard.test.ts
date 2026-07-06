import { describe, it, expect } from 'vitest';
import { compile } from 'svelte/compiler';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards against the sona#73 bug class: `const { image } = data` (or any prop
// value read once at init) that goes stale on a same-route client-side nav.
// Svelte's compiler flags exactly this as `state_referenced_locally`, so we
// compile every public route page and require zero — svelte-check surfaces the
// same warning but does not fail CI.
//
// BASELINE: files that still carry warnings of this class. They're excused at
// their exact current count; this is a ratchet — drive these numbers DOWN over
// time, never up. See the follow-up issue.
//
// gallery/+page.svelte stays: 2 of its 3 warnings are mechanical meta consts,
// but the third is `artistQuery = $state(data.filters.artist)` — user-input
// state seeded from data with a sync $effect, which needs real reasoning to
// convert. Deferred whole (not partially touched) to keep the fix mechanical.
const BASELINE: Record<string, number> = {
	'(public)/gallery/+page.svelte': 3
};

const routesDir = fileURLToPath(new URL('.', import.meta.url));
// readdirSync recursive (Node 20.1+) rather than fs.globSync (Node 22+) — the
// fork deploy CI runs the suite on Node 20.
const pages = readdirSync(routesDir, { recursive: true })
	.map((p) => String(p))
	.filter((p) => p.split(/[/\\]/).pop() === '+page.svelte')
	.sort();

function warningCount(fileUrl: URL, filename: string): number {
	const src = readFileSync(fileUrl, 'utf8');
	const { warnings } = compile(src, { filename, generate: 'client' });
	return warnings.filter((w) => w.code === 'state_referenced_locally').length;
}

describe('public route pages: no stale prop reads (state_referenced_locally)', () => {
	it('finds the public route pages to check', () => {
		// Coverage floor: this repo has 9 public route pages; a drop below means
		// the scan silently stopped covering some.
		expect(pages.length).toBeGreaterThanOrEqual(9);
	});

	for (const rel of pages) {
		const key = `(public)/${rel.split(/[/\\]/).join('/')}`;
		const allowed = BASELINE[key] ?? 0;
		it(`${key} has exactly ${allowed} state_referenced_locally warning(s)`, () => {
			// Exact match: fixing a baseline file must also zero its entry here.
			expect(warningCount(new URL(rel, new URL('.', import.meta.url)), key)).toBe(allowed);
		});
	}

	// Meta.svelte lives outside the route scan but carries the same bug class (its
	// og:* tags go stale on a same-route nav), so guard it explicitly too.
	it('lib/components/Meta.svelte has exactly 0 state_referenced_locally warning(s)', () => {
		const url = new URL('../../lib/components/Meta.svelte', new URL('.', import.meta.url));
		expect(warningCount(url, 'lib/components/Meta.svelte')).toBe(0);
	});
});
