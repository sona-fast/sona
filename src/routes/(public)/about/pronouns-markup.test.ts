import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';

// SONA-210: /about renders the owner's pronouns under their name. Source scan
// rather than a render, for the reason social-chips.test.ts gives — the page
// pulls in $app/state and paraglide, and mounting it under this pure-TS vitest
// setup would cost more than it proves.

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

/** The pronouns paragraph and everything in it. */
const block = source.match(/<p class="pronouns">[\s\S]*?<\/p>/)?.[0] ?? '';

describe('/about pronouns line', () => {
	it('renders under the name and above the bio', () => {
		expect(block).not.toBe('');
		expect(source.indexOf('<h1>{ownerName}</h1>')).toBeLessThan(source.indexOf(block));
		expect(source.indexOf(block)).toBeLessThan(source.indexOf('<p class="bio">'));
	});

	it('renders nothing at all when the setting is blank', () => {
		// Guarded, not styled-empty: an unconditional paragraph would hold a gap
		// under the name of every owner who has set no pronouns.
		expect(source).toMatch(/\{#if settings\.pronouns\}[\s\S]*?<p class="pronouns">/);
	});

	it('carries a visually hidden prefix, so the line says what it is', () => {
		// Out of context a screen reader announces "they/them" straight after the
		// heading, which does not say that it IS a pronouns line.
		expect(block).toContain('{m.pronouns_prefix()}');

		// And the separator survives compilation. Asserted on the compiled output,
		// not the source: Svelte trims a trailing space written as text inside the
		// span, which glues the prefix to the value ("Pronouns:they/them"). The
		// {' '} idiom is what keeps it.
		const compiled = compile(source, { generate: 'server' }).js.code;
		expect(compiled).toMatch(/pronouns_prefix\(\)[^<]* <\/span>/);
	});

	it('prints the operator-entered value verbatim', () => {
		// No formatter, no split on the slash, no capitalization: whatever they
		// typed is what renders.
		expect(block).toContain('{settings.pronouns}');
	});

	it('can break a long unbroken value instead of pushing the page sideways', () => {
		// The card centres its children, so without this a 100-character value sets
		// the block's min-content width and the whole page scrolls at 390px.
		// `break-word` is not enough: it wraps but measures the same.
		const rule = source.match(/\.pronouns \{[^}]*\}/)?.[0] ?? '';
		expect(rule).toContain('overflow-wrap: anywhere');
	});
});
