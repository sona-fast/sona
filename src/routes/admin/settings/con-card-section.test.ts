import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as m from '$lib/paraglide/messages';

// Source-pin for the con card section of the settings page, per the
// ut-stat-gate.test.ts precedent: source text is all a wiring test can observe
// here, and the failure this covers only happens across a deploy boundary.

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('con card section', () => {
	it('handles a lazy chunk that no longer exists', () => {
		// The ConCard chunk is imported on demand. A client sitting on this page
		// across a deploy asks for a hash that is gone, and without a :catch that
		// rejection is an unhandled error rather than something the operator can
		// act on.
		expect(source).toMatch(
			/\{#await import\('\$lib\/components\/ConCard\.svelte'\)[\s\S]*?\{:catch\}[\s\S]*?\{\/await\}/
		);
		expect(source).toMatch(/\{:catch\}[\s\S]*?\{m\.admin_settings_con_card_failed\(\)\}/);
	});

	it('tells the operator what to do about it', () => {
		// Recoverable, so the message has to name the recovery: this one is only
		// fixed by reloading, which the operator has no reason to guess.
		expect(m.admin_settings_con_card_failed()).toMatch(/reload/i);
	});
});
