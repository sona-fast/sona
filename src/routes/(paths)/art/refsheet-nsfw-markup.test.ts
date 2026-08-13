import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the /art ref-sheet NSFW shield (SONA-18), following the
// nsfw-markup.test.ts precedent on the VR detail page: the shield is a pair of
// one-line conditions whose silent loss doesn't fail anything else — it just
// renders mature content unblurred on a public page.
const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('/art ref-sheet NSFW shield (SONA-18)', () => {
	it('gates the ref-sheet frame on the flag the load carries through', () => {
		expect(pageSrc).toContain('{#if data.refSheet.nsfw && !revealed}');
		expect(pageSrc).toContain('class="blurred"');
	});

	it('shows the same reveal affordance as the gallery hero', () => {
		expect(pageSrc).toMatch(/<button class="reveal-btn" onclick=\{reveal\}>/);
		expect(pageSrc).toContain('{m.gallery_nsfw_content()}');
		expect(pageSrc).toContain('{m.gallery_click_reveal()}');
	});

	it('announces the reveal and moves focus (the button unmounts itself)', () => {
		expect(pageSrc).toContain('<p class="sr-only" role="status">{revealAnnouncement}</p>');
		expect(pageSrc).toContain('revealedRef?.focus()');
	});

	// While shielded the frame is a <div>, not the gallery <a>: a reveal button
	// nested inside the link would put two competing targets on one image.
	it('does not nest the reveal button inside the gallery link', () => {
		const shielded = pageSrc.match(/\{#if data\.refSheet\.nsfw && !revealed\}[\s\S]*?\{:else\}/)?.[0];
		expect(shielded).toBeTruthy();
		expect(shielded).toContain('<div class="ref-sheet shielded">');
		expect(shielded).not.toContain('<a ');
	});

	// Shielded, the frame is a button, so the caption carries the gallery link —
	// otherwise the ref sheet has no route onward at all without JS.
	it('moves the full-size link into the caption while shielded', () => {
		expect(pageSrc).toContain('<a href={`/gallery/${data.refSheet.slug}`}>{m.art_ref_view_full()}</a>');
	});
});
