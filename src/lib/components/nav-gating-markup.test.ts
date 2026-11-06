import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the Collections flag reaching the Header, per the
// vr/[slug]/nsfw-markup.test.ts precedent: the Header's default fails OPEN,
// so a dropped prop pass silently un-gates the link and nothing else would
// notice. The gallery tab bar's gating lives in galleryTabs
// ($lib/gallery-tabs.test.ts), and GalleryTabs takes every flag as a required
// prop, so the type check catches a dropped one there.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const publicLayoutSrc = read('../../routes/(public)/+layout.svelte');
const homeSrc = read('../../routes/(public)/+page@.svelte');

describe('the Collections flag is plumbed into the Header', () => {
	it('(public) layout passes it', () => {
		expect(publicLayoutSrc).toMatch(/<Header[^>]*collectionsEnabled=\{data\.collectionsEnabled\}/);
	});

	it('the homepage (+page@ escapes that layout) passes it to EVERY branch', () => {
		// threePath, passport and mosaic each render a Header; a dropped pass
		// anywhere lowers the count.
		expect(homeSrc.match(/collectionsEnabled=\{data\.collectionsEnabled\}/g)).toHaveLength(3);
	});
});
