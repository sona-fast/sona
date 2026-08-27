import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// SONA-210: the pronouns ride the here-now block on /connect and nowhere else on
// the page. That block is read in a hallway by someone who met the operator
// minutes ago, which is the moment the line is worth carrying; the rest of the
// page is read at leisure with the About section already naming them.
//
// Source scan, per the social-rows.test.ts precedent on this same page.

const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

/** The here-now identity block: avatar, name, pronouns. */
const ident = source.match(/<div class="here-ident">[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? '';

describe('/connect here-now pronouns', () => {
	it('sits inside the here-now identity block, under the name', () => {
		expect(ident).not.toBe('');
		expect(ident).toContain('{personaName}');
		expect(ident.indexOf('here-who')).toBeLessThan(ident.indexOf('here-pronouns'));
	});

	it('renders nothing when the setting is blank', () => {
		expect(ident).toMatch(/\{#if data\.settings\.pronouns\}[\s\S]*?here-pronouns/);
	});

	it('carries the same visually hidden prefix /about uses', () => {
		expect(ident).toContain('{m.pronouns_prefix()}');
		expect(ident).toContain('{data.settings.pronouns}');

		// Svelte trims a trailing space written as text inside the span, so the
		// separator has to be the `{' '}` expression. That the idiom actually
		// survives compilation is asserted once, over in /about's copy of this test.
		expect(ident).toContain("{m.pronouns_prefix()}{' '}");
	});

	// The block's ground is washed with --primary, so the page's flat muted grey
	// reads dull on it. A tint of the same primary keeps the line quiet and still
	// clears 4.5:1 in both themes; reverting it to --muted-foreground is the
	// regression this pins.
	it('tints the line against the block primary-washed ground', () => {
		// Structure only — that the colour is the primary mixed into the muted
		// grey, not the flat token. The ratio the mix has to clear is measured in
		// theme-contrast.test.ts, which is where the percentage belongs.
		const rule = source.match(/\.here-pronouns \{[^}]*\}/)?.[0] ?? '';
		expect(rule).toMatch(/color:\s*color-mix\(/);
		expect(rule).toContain('var(--primary)');
		expect(rule).toContain('var(--muted-foreground)');
	});

	it('reads the setting nowhere else on the page', () => {
		// The property, not a count: every reference the file makes is one the
		// here-now identity block makes. A second line elsewhere breaks it.
		const inFile = [...source.matchAll(/data\.settings\.pronouns/g)].length;
		const inBlock = [...ident.matchAll(/data\.settings\.pronouns/g)].length;
		expect(inBlock).toBeGreaterThan(0);
		expect(inFile).toBe(inBlock);
	});

	it('can break a long unbroken value instead of widening the card', () => {
		// `break-word` is enough here, unlike /about and /art: the line's own
		// ancestors carry min-width: 0, so wrapping is all that is needed to keep
		// the flex item from setting a min-content floor (measured clean at 320
		// and 390). The two zeroes are load-bearing for that, so pin them beside
		// it — drop either one and break-word alone stops holding the card.
		const rules = (name: string) => source.match(new RegExp(`\\.${name} \\{[^}]*\\}`))?.[0] ?? '';
		expect(rules('here-pronouns')).toContain('overflow-wrap: break-word');
		expect(rules('here-ident')).toContain('min-width: 0');
		expect(rules('here-name-col')).toContain('min-width: 0');
	});
});
