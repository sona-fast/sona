import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the content-gating conditionals around every Stickers /
// Collections / VR nav entry, per the vr/[slug]/nsfw-markup.test.ts precedent:
// nothing else executes these wrappers, and a deleted {#if} fails silently
// (the link simply renders again on a fork with no content behind it). Each
// pin is a minimal discriminator fragment — the flag next to the href it
// gates — not a verbatim copy of the whole expression.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const headerSrc = read('./Header.svelte');
const mobileNavSrc = read('./MobileNav.svelte');
const gallerySrc = read('../../routes/(public)/gallery/+page.svelte');
const vrSrc = read('../../routes/(public)/vr/+page.svelte');
const publicLayoutSrc = read('../../routes/(public)/+layout.svelte');
const homeSrc = read('../../routes/(public)/+page@.svelte');
const pathsLayoutSrc = read('../../routes/(paths)/+layout.svelte');

describe('gallery tab bar gating markup', () => {
	it('wraps the Stickers pill in the stickersEnabled conditional', () => {
		expect(gallerySrc).toMatch(/\{#if data\.stickersEnabled\}\s*<a href="\/stickers"/);
	});

	it('wraps the VR pill in the vrEnabled conditional', () => {
		expect(gallerySrc).toMatch(/\{#if data\.vrEnabled\}\s*<a href="\/vr"/);
	});

	it('suppresses the whole tab bar unless a second pill would show', () => {
		expect(gallerySrc).toMatch(
			/\{#if data\.fursuitEnabled \|\| data\.stickersEnabled \|\| data\.vrEnabled\}\s*<div class="tabs"/
		);
	});
});

describe('/vr tab bar gating markup', () => {
	it('wraps the Stickers pill in the stickersEnabled conditional', () => {
		expect(vrSrc).toMatch(/\{#if data\.stickersEnabled\}\s*<a href="\/stickers"/);
	});
});

describe('Header nav gating markup', () => {
	it('gates the /stickers link on stickersEnabled', () => {
		expect(headerSrc).toMatch(/stickersEnabled \? \[\{ href: '\/stickers'/);
	});

	it('gates the /collections link on collectionsEnabled', () => {
		expect(headerSrc).toMatch(/collectionsEnabled \? \[\{ href: '\/collections'/);
	});
});

describe('MobileNav gating markup', () => {
	it('gates the /stickers tab on stickersEnabled', () => {
		expect(mobileNavSrc).toMatch(/stickersEnabled \? \[\{ href: '\/stickers'/);
	});
});

describe('the flags are actually plumbed into the nav components', () => {
	// The component defaults fail OPEN, so a dropped prop pass silently
	// un-gates the nav — pin each pass site. The Header pins are scoped to the
	// <Header …> tag so the sibling MobileNav pass can't satisfy them.
	it('(public) layout passes both flags to Header and the stickers flag to MobileNav', () => {
		expect(publicLayoutSrc).toMatch(/<Header[^>]*stickersEnabled=\{data\.stickersEnabled\}/);
		expect(publicLayoutSrc).toMatch(/<Header[^>]*collectionsEnabled=\{data\.collectionsEnabled\}/);
		expect(publicLayoutSrc).toContain('<MobileNav stickersEnabled={data.stickersEnabled} />');
	});

	it('the homepage (+page@ escapes that layout) passes them to BOTH branches', () => {
		// 2 Headers + 2 MobileNavs carry the stickers flag; both Headers carry
		// the collections flag — a dropped pass anywhere lowers its count.
		expect(homeSrc.match(/stickersEnabled=\{data\.stickersEnabled\}/g)).toHaveLength(4);
		expect(homeSrc.match(/collectionsEnabled=\{data\.collectionsEnabled\}/g)).toHaveLength(2);
	});

	it('the (paths) layout passes the stickers flag to MobileNav', () => {
		expect(pathsLayoutSrc).toContain('<MobileNav stickersEnabled={data.stickersEnabled} />');
	});
});
