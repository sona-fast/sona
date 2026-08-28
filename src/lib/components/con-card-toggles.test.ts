import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as m from '$lib/paraglide/messages';

// SONA-210: the pronouns toggle on the con card generator. Source scan, per the
// con-card-section.test.ts precedent — the component builds two SVGs and
// rasterizes through a canvas, none of which this vitest setup has. What the
// toggle DOES to the preview is covered in a browser by tests/e2e/con-card.spec.ts.

const source = readFileSync(new URL('./ConCard.svelte', import.meta.url), 'utf8');

/** Every `{#if <test>}` block in the markup, nested blocks kept whole. A
 *  non-greedy regex stops at the first `{/if}`, which is the wrong one as soon as
 *  anything nests inside. */
function ifBlocks(test: string): string[] {
	const open = `{#if ${test}}`;
	const found: string[] = [];
	for (let at = source.indexOf(open); at >= 0; at = source.indexOf(open, at + open.length)) {
		let depth = 0;
		for (const token of source.slice(at).matchAll(/\{#if |\{\/if\}/g)) {
			depth += token[0] === '{/if}' ? -1 : 1;
			if (depth === 0) {
				found.push(source.slice(at, at + (token.index ?? 0) + token[0].length));
				break;
			}
		}
	}
	return found;
}

describe('con card pronouns toggle', () => {
	it('is absent — not disabled — when no pronouns are set', () => {
		// A greyed box would put the question to an operator who already answered
		// it by leaving the setting empty.
		expect(source).toMatch(/\{#if pronouns\}\s*<label><input type="checkbox" bind:checked=\{includePronouns\}/);
		expect(source).not.toMatch(/bind:checked=\{includePronouns\}[^>]*disabled/);
	});

	it('feeds the card null when the box is off, so the line is dropped', () => {
		expect(source).toContain('pronouns: includePronouns ? pronouns : null');
		// And the front face's accessible name follows the same value: the preview
		// is a picture, so without this a screen reader hears the same title
		// whichever boxes are ticked.
		expect(source).toContain("shared.pronouns ? m.con_card_field_pronouns() : ''");
	});

	it('starts on, and ticks itself when the setting is filled in on this page', () => {
		// `initial` is untracked, so a prop change never re-ticks a box the operator
		// has just unticked. The effect covers the one case that is not a re-tick:
		// with no pronouns set there was no box at all, so a value saved on this
		// same settings page has no earlier choice to overwrite.
		expect(source).toMatch(/const initial = untrack\(\(\) => \(\{[\s\S]*?pronouns: !!pronouns/);
		expect(source).toContain('let includePronouns = $state(initial.pronouns);');
		expect(source).toMatch(/if \(has\.pronouns && !had\.pronouns\) includePronouns = true;/);
		// The effect must not READ any include state, or writing it loops: each
		// include* mention in its body is the assignment above, no more.
		const effect = source.match(/\$effect\(\(\) => \{[\s\S]*?had = \{[\s\S]*?\};[\s\S]*?\}\);/)?.[0] ?? '';
		for (const name of ['includeSpecies', 'includePronouns', 'includeColors', 'includeCredit']) {
			expect(effect.match(new RegExp(name, 'g'))).toHaveLength(1);
		}
		// `had` is monotonic — untick, clear, restore must not re-tick a box the
		// operator already chose to leave off — so each field merges with ||,
		// never resets from the current `has` alone.
		for (const field of ['species', 'pronouns', 'colors', 'credit']) {
			expect(effect).toContain(`${field}: had.${field} || has.${field}`);
		}
	});

	it('says that cards already printed keep what was on them', () => {
		const note = source.match(/<p[^>]*id="con-card-printed-note"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
		expect(note).toContain('{m.con_card_printed_note()}');
		// The point of the line is the printed object, so it has to name it.
		expect(m.con_card_printed_note()).toMatch(/print/i);
	});

	it('points the group it describes at the note', () => {
		// So a screen reader reaching the first checkbox has heard the caveat.
		expect(source).toContain('<fieldset class="includes" aria-describedby="con-card-printed-note">');
	});

	it('never hangs the note off the pronouns setting alone', () => {
		// The note is true of every include box, so it renders wherever the fieldset
		// does. Structural rather than adjacency: a comment line between the guard
		// and the <p> slips past a "guard immediately before the note" regex.
		const guarded = ifBlocks('pronouns');
		expect(guarded.length).toBeGreaterThan(0);
		for (const block of guarded) expect(block).not.toContain('con-card-printed-note');
	});

	it('drops the whole include group when there is nothing to include', () => {
		// A fresh install has no species, pronouns, colours or artist credit: an
		// empty fieldset with a note about boxes that aren't there is worse than
		// neither, so both sit inside one guard.
		const [block = ''] = ifBlocks('hasIncludes');
		expect(block).toContain('<fieldset class="includes" aria-describedby="con-card-printed-note">');
		expect(block).toContain('con-card-printed-note');
		// The handles group keeps its own guard, outside this one.
		expect(block).not.toContain('con_card_handles');
	});

	it('counts pronouns alone as something to include', () => {
		// The guard's operands are what decide whether an operator whose ONLY
		// filled field is pronouns still gets the box and the printed-card note.
		// Evaluated rather than string-matched, so a reformat survives but a
		// dropped operand does not: the extraction failing yields `return ();`,
		// a loud SyntaxError, never a vacuous pass.
		const [, expr = ''] = source.match(/const hasIncludes = \$derived\(([\s\S]*?)\);/) ?? [];
		const guard = new Function('species', 'pronouns', 'colors', 'artCredit', `return (${expr});`);
		expect(guard('', 'they/them', [], null)).toBe(true);
		expect(guard('', '', [], null)).toBe(false);
	});
});
