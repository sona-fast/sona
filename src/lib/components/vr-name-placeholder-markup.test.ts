import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the avatar-name placeholder wiring, per the
// nav-gating-markup.test.ts precedent: namePlaceholderCharacter is unit-tested
// in vr.test.ts, but nothing executes the component, so the two lines that
// carry its result to the input fail silently. Dropping the $derived freezes
// the placeholder at load (it stops following the character select) and
// passing a literal instead of the derived value reinstates a stock example;
// both still typecheck and pass every other test.

const src = readFileSync(new URL('./VrAvatarForm.svelte', import.meta.url), 'utf8');

describe('avatar-name placeholder wiring', () => {
	it('derives the placeholder character so it follows the character select', () => {
		expect(src).toMatch(
			/\$derived\(\s*namePlaceholderCharacter\(characters, characterId, m\.admin_vr_name_placeholder_fallback\(\)\)\s*\)/
		);
	});

	it('passes the derived character into the placeholder message as {name}', () => {
		expect(src).toContain('m.admin_vr_name_placeholder({ name: placeholderCharacter })');
	});
});
