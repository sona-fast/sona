import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { showUtFileStat } from './ut-stat';

// Two layers, two tools, on purpose:
//  - The PREDICATE (showUtFileStat) is guarded by VALUE below, so it is immune
//    to equivalent rewrites and cannot be quietly weakened (drop/negate a clause).
//  - Its WIRING in +page.svelte is guarded by SPELLING here: the template just
//    calls the helper, there is nothing to evaluate. A value test cannot see
//    whether the `{#if}` actually IS the helper call, so the only thing that
//    catches "someone inlined the condition again" (which silently removes the
//    value-tested layer) is asserting on the source text of the guard itself.
// Do NOT reintroduce any assertion about the predicate's *contents* in the
// template — that was the hopeless source-scrape the value test replaced.

// Value test for the UploadThing file-count stat gate.
//
// +page.server.ts populates `utUsage` whenever UPLOADTHING_TOKEN exists,
// REGARDLESS of the active storage provider. So `utUsage` being truthy does NOT
// mean UploadThing is the live store — on a site that migrated UT -> R2 (the
// real sparky.ink situation) `utUsage` is still truthy but the file count is
// stale. The provider clause is the only thing hiding that stale count, which is
// why this test asserts on the returned boolean rather than the page source: a
// value test rejects equivalent-looking lies (drop/negate the provider clause)
// while accepting equivalent spellings.

describe('showUtFileStat', () => {
	const utUsage = { usedBytes: 1, limitBytes: 10, filesUploaded: 42 };

	it('shows the stat when utUsage is present and provider is uploadthing', () => {
		expect(showUtFileStat({ utUsage, settings: { storageProvider: 'uploadthing' } })).toBe(true);
	});

	it('hides the stat on a migrated R2 site even though utUsage is still present', () => {
		expect(showUtFileStat({ utUsage, settings: { storageProvider: 'r2' } })).toBe(false);
	});

	it('hides the stat when utUsage is null even on the uploadthing provider', () => {
		expect(showUtFileStat({ utUsage: null, settings: { storageProvider: 'uploadthing' } })).toBe(
			false
		);
		expect(
			showUtFileStat({ utUsage: undefined, settings: { storageProvider: 'uploadthing' } })
		).toBe(false);
	});

	it('hides the stat when utUsage is null and provider is r2', () => {
		expect(showUtFileStat({ utUsage: null, settings: { storageProvider: 'r2' } })).toBe(false);
	});
});

describe('showUtFileStat wiring in +page.svelte', () => {
	const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

	it('imports showUtFileStat in the <script> block', () => {
		const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '';
		expect(script).toMatch(/import\s*\{[^}]*\bshowUtFileStat\b[^}]*\}\s*from\s*['"]\.\/ut-stat['"]/);
	});

	it('guards data.utUsage.filesUploaded with the helper call, not an inline expression', () => {
		const target = source.indexOf('data.utUsage.filesUploaded');
		expect(target).toBeGreaterThan(-1);

		// The nearest preceding `{#if ...}` before the render of filesUploaded must
		// be exactly the helper call. An inlined condition here is a real regression:
		// it renders correctly but silently bypasses the value-tested predicate.
		const before = source.slice(0, target);
		const conditions = [...before.matchAll(/\{#if\s+([\s\S]*?)\}/g)];
		expect(conditions.length).toBeGreaterThan(0);
		const nearest = conditions[conditions.length - 1][1].trim();
		expect(nearest).toBe('showUtFileStat(data)');
	});
});
