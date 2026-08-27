import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// SONA-210: pronouns are one more row in the /art details list. Source scan, per
// the featured-markup.test.ts precedent on this page.

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

/** The details array literal, which is what the page renders rows from. */
const details = source.match(/const details = \$derived\(\s*\[[\s\S]*?\]/)?.[0] ?? '';

/** Each row's message key, in the order the page lists them. */
const labels = [...details.matchAll(/label: m\.(\w+)\(\)/g)].map(([, key]) => key);

/** The rows the page would actually render for a given sona, by evaluating the
 *  page's own `details` expression. A source scan can only see the filter's
 *  text; this runs it, so a refactor to per-row {#if} has to keep the behaviour
 *  rather than just the wording. */
const detailsExpr = source.match(/const details = \$derived\(([\s\S]*?)\n\t\);/)?.[1] ?? '';
const buildDetails = new Function(
	'm',
	'data',
	`return (${detailsExpr});`
) as (m: Record<string, () => string>, data: unknown) => Array<{ label: string; value: unknown }>;
const messages = new Proxy({} as Record<string, () => string>, {
	get: (_t, key: string) => () => key
});
function rowsFor(sona: Record<string, unknown>) {
	return buildDetails(messages, { sona });
}

describe('/art pronouns row', () => {
	it('is the last row, after the character key features', () => {
		// Order is the assertion: the rows above describe the character an artist
		// draws from, and this one is the operator's. Ahead of them it reads as
		// part of the reference.
		expect(labels).toEqual(['art_species', 'art_build', 'art_features', 'art_pronouns']);
	});

	it('reads the operator setting, not a character field', () => {
		expect(details).toContain('value: data.sona.pronouns');
	});

	it('leaves the row out entirely when the setting is blank', () => {
		// A bare "Pronouns" label over an empty value is the failure: the operator
		// who never set them gets a row announcing they have none. The list is
		// filtered on value, so an unset setting drops the whole row, label
		// included. (Whitespace is trimmed off on the write path, not here.)
		const filled = rowsFor({ species: 'Red panda', build: null, keyFeatures: null, pronouns: 'they/them' });
		expect(filled.map((d) => d.label)).toEqual(['art_species', 'art_pronouns']);

		for (const blank of [null, undefined, '']) {
			const rows = rowsFor({ species: 'Red panda', build: null, keyFeatures: null, pronouns: blank });
			expect(rows.map((d) => d.label), String(blank)).toEqual(['art_species']);
		}

		// And a sona with nothing set renders no details list at all.
		expect(rowsFor({ species: null, build: null, keyFeatures: null, pronouns: null })).toEqual([]);
	});

	it('can break a long unbroken value instead of pushing the page sideways', () => {
		// Same pin as /about's pronouns line: the value is operator-typed, so a
		// 100-character run with no spaces is reachable. `break-word` is not
		// enough here — the row is a flex row, and break-word wraps the text while
		// leaving the item's min-content width intact (measured: 784px scrollWidth
		// at a 320px viewport). `anywhere` is what shrinks the measurement.
		const rule = source.match(/\.detail-value \{[^}]*\}/)?.[0] ?? '';
		expect(rule).toContain('overflow-wrap: anywhere');
	});
});
