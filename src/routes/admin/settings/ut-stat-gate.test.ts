import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { showUtFileStat } from './ut-stat';

// The predicate is tested by value; the template is checked only to confirm it
// delegates to the helper (that the file-count render sits inside the helper's
// own {#if} block), since source text is all a wiring test can observe.

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

	it('renders data.utUsage.filesUploaded exactly once, inside the showUtFileStat block', () => {
		// Exactly one render, so a second unguarded copy elsewhere can't hide.
		const renders = [...source.matchAll(/data\.utUsage\.filesUploaded/g)];
		expect(renders).toHaveLength(1);
		const renderAt = renders[0].index;

		const openTag = '{#if showUtFileStat(data)}';
		const openAt = source.indexOf(openTag);
		expect(openAt).toBeGreaterThan(-1);
		const bodyStart = openAt + openTag.length;

		// Walk {#if}/{/if} depth from the helper's opening tag to find its MATCHING
		// {/if}, tracking nesting so a render moved past the block (or into a sibling
		// branch) is not mistaken for a guarded one.
		let depth = 1;
		let closeAt = -1;
		for (const tag of source.matchAll(/\{#if\b|\{\/if\}/g)) {
			if (tag.index < bodyStart) continue;
			depth += tag[0] === '{/if}' ? -1 : 1;
			if (depth === 0) {
				closeAt = tag.index;
				break;
			}
		}
		expect(closeAt).toBeGreaterThan(-1);

		// The single render must sit strictly inside the helper's own block.
		expect(renderAt).toBeGreaterThan(bodyStart);
		expect(renderAt).toBeLessThan(closeAt);
	});
});
