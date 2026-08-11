import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pin for the cover-picker thumbnail sizing, per the refsheet-lcp /
// nav-gating-markup precedent: this grid is the collections twin of the VR
// poster picker (see the .poster-option img comment in VrAvatarForm.svelte),
// but only the poster picker has e2e coverage — a regression here to
// height:100% would ship silently, collapsing lazy/404 thumbnails into
// slivers again.

const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('collections cover-picker thumbnail sizing', () => {
	// Strip CSS comments first — the rule's own comment says "not height:100%",
	// which would otherwise trip the negative match below.
	const imgRule = (pageSrc.match(/\.cover-option img \{[\s\S]*?\}/)?.[0] ?? '').replace(
		/\/\*[\s\S]*?\*\//g,
		''
	);

	it('squares the img via its own aspect-ratio, not height:100%', () => {
		expect(imgRule).toContain('aspect-ratio: 1');
		expect(imgRule).toContain('height: auto');
		expect(imgRule).not.toMatch(/height:\s*100%/);
	});

	it('keeps the aspect-ratio on the .cover-option button too', () => {
		const buttonRule = pageSrc.match(/\.cover-option \{[\s\S]*?\}/)?.[0] ?? '';
		expect(buttonRule).toContain('aspect-ratio: 1');
	});
});
