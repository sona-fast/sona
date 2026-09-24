import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';

// SONA-210: /about renders the owner's pronouns under their name. Source scan
// rather than a render: the page pulls in $app/state and paraglide, and
// mounting it under this pure-TS vitest setup would cost more than it proves.

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

/** The pronouns paragraph and everything in it. */
const block = source.match(/<p class="pronouns">[\s\S]*?<\/p>/)?.[0] ?? '';

describe('/about pronouns line', () => {
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
});
