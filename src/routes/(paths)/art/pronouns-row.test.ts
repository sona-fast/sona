import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// SONA-210: pronouns are one more row in the /art details list. Source scan.

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

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
});
