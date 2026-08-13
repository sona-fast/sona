import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pin for LinkRow's optional subtitle, per the nav-gating-markup.test.ts
// precedent: nothing renders this component under the pure-TS vitest setup, and
// dropping the {#if} fails silently — an empty `.sub` span still lays out, so a
// row with no handle would gain a stray gap and an empty line for screen
// readers. Pin the discriminator (the conditional around the span), not the
// component's markup verbatim.

const source = readFileSync(new URL('./LinkRow.svelte', import.meta.url), 'utf8');

describe('LinkRow subtitle markup', () => {
	it('renders the subtitle span only when there is a subtitle', () => {
		expect(source).toMatch(/\{#if subtitle\}[\s\S]*?<span class="sub">/);
	});

	it('keeps the subtitle prop optional', () => {
		expect(source).toMatch(/subtitle\?:\s*string/);
	});
});
