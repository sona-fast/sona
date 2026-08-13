import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the reference control's variant branch (SONA-18). The server
// action's 400 is unit-tested, but the branch that keeps an operator from
// hitting that 400 blind is markup, and this repo has no component-render
// harness — same precedent as the /art and VR detail nsfw-markup pins.
const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('admin image edit — reference control variant branch (SONA-18)', () => {
	it('replaces the set button with the variant hint', () => {
		expect(pageSrc).toContain('{:else if data.image.parentImageId != null}');
		expect(pageSrc).toContain('{m.admin_image_reference_variant()}');
	});

	// Order matters: a variant designated before this rule must still be
	// clearable, so the clear branch has to be tested before the variant branch.
	it('keeps the clear branch ahead of the variant branch', () => {
		const clearAt = pageSrc.indexOf('{#if data.ownerCharacter.isReference}');
		const variantAt = pageSrc.indexOf('{:else if data.image.parentImageId != null}');
		expect(clearAt).toBeGreaterThan(-1);
		expect(variantAt).toBeGreaterThan(clearAt);
	});

	// A designation made before the variant rule keeps the clear branch, so the
	// hint has to appear inside it too — otherwise the admin says "this is the
	// reference sheet" about a row /art has already stopped showing.
	it('shows the hint alongside clear when the designated image is a variant', () => {
		const clearBranch = pageSrc.slice(
			pageSrc.indexOf('{#if data.ownerCharacter.isReference}\n\t\t\t\t\t<input'),
			pageSrc.indexOf('{:else if data.image.parentImageId != null}')
		);
		expect(clearBranch).toContain('{#if data.image.parentImageId != null}');
		expect(clearBranch).toContain('{m.admin_image_reference_variant()}');
	});

	// Clearing on a variant removes the button entirely: focus has to land
	// somewhere and the live region has to say something, or the operator gets
	// silence and a lost place in the page.
	it('lands focus on the hint and announces the clear when no button remains', () => {
		expect(pageSrc).toContain('(referenceButton ?? referenceHint)?.focus()');
		expect(pageSrc).toContain('bind:this={referenceHint}');
		expect(pageSrc).toContain('{m.admin_image_reference_cleared()}');
	});

	// Without this the announcement branch stays in the file and never fires —
	// the flag is what enables it, and it is the only feedback on the variant
	// path, where clearing removes the button focus would otherwise return to.
	it('derives the announcement from what the action reports', () => {
		expect(pageSrc).toMatch(/referenceCleared = result\.data\?\.referenceCleared === true/);
	});
});
