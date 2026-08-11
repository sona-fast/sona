import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the content-gating conditionals around every Stickers /
// Collections / VR nav entry, per the vr/[slug]/nsfw-markup.test.ts precedent:
// nothing else executes these wrappers, and a deleted {#if} fails silently
// (the link simply renders again on a fork with no content behind it).

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
		expect(gallerySrc).toMatch(/\{#if data\.stickersEnabled\}\s*<a href="\/stickers" class="tab">/);
	});

	it('wraps the VR pill in the vrEnabled conditional', () => {
		expect(gallerySrc).toMatch(/\{#if data\.vrEnabled\}\s*<a href="\/vr" class="tab">/);
	});

	it('suppresses the whole tab bar unless a second pill would show', () => {
		expect(gallerySrc).toMatch(
			/\{#if data\.fursuitEnabled \|\| data\.stickersEnabled \|\| data\.vrEnabled\}\s*<div class="tabs" role="tablist">/
		);
	});
});

describe('/vr tab bar gating markup', () => {
	it('wraps the Stickers pill in the stickersEnabled conditional', () => {
		expect(vrSrc).toMatch(/\{#if data\.stickersEnabled\}\s*<a href="\/stickers" class="tab">/);
	});
});

describe('Header nav gating markup', () => {
	it('gates the /stickers link on stickersEnabled', () => {
		expect(headerSrc).toContain(
			"...(stickersEnabled ? [{ href: '/stickers', label: m.nav_stickers }] : [])"
		);
	});

	it('gates the /collections link on collectionsEnabled', () => {
		expect(headerSrc).toContain(
			"...(collectionsEnabled ? [{ href: '/collections', label: m.nav_collections }] : [])"
		);
	});

	it('always lists Gallery and About', () => {
		expect(headerSrc).toContain("{ href: '/gallery', label: m.nav_gallery },");
		expect(headerSrc).toContain("{ href: '/about', label: m.nav_about }");
	});
});

describe('MobileNav gating markup', () => {
	it('gates the /stickers tab on stickersEnabled (it has no Collections tab)', () => {
		expect(mobileNavSrc).toContain(
			"...(stickersEnabled ? [{ href: '/stickers', label: m.nav_stickers, icon: Sticker }] : [])"
		);
		expect(mobileNavSrc).not.toContain('/collections');
	});
});

describe('the flags are actually plumbed into the nav components', () => {
	// The component defaults fail OPEN, so a dropped prop pass silently
	// un-gates the nav — pin each pass site.
	it('(public) layout passes both flags to Header and the stickers flag to MobileNav', () => {
		expect(publicLayoutSrc).toContain('stickersEnabled={data.stickersEnabled}');
		expect(publicLayoutSrc).toContain('collectionsEnabled={data.collectionsEnabled}');
		expect(publicLayoutSrc).toContain('<MobileNav stickersEnabled={data.stickersEnabled} />');
	});

	it('the homepage (+page@ escapes that layout) passes them to BOTH branches', () => {
		expect(homeSrc.match(/stickersEnabled=\{data\.stickersEnabled\}/g)).toHaveLength(4);
		expect(homeSrc.match(/collectionsEnabled=\{data\.collectionsEnabled\}/g)).toHaveLength(2);
	});

	it('the (paths) layout passes the stickers flag to MobileNav', () => {
		expect(pathsLayoutSrc).toContain('<MobileNav stickersEnabled={data.stickersEnabled} />');
	});
});
