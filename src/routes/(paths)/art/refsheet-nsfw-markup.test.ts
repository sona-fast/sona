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
	// otherwise the ref sheet has no route onward at all without JS. It says
	// "open in the gallery" because that page shields the same image again.
	it('moves the route onward into the caption while shielded', () => {
		expect(pageSrc).toContain(
			'<a class="next-sentence" href={`/gallery/${data.refSheet.slug}`}>{m.art_ref_open_gallery()}</a>'
		);
	});

	// The unshielded arm keeps the "view full size" half of the split caption;
	// dropping it would quietly lose that line for every SFW visitor.
	it('keeps the full-size line in the caption when not shielded', () => {
		expect(pageSrc).toContain('<span class="next-sentence">{m.art_ref_view_full()}</span>');
	});

	// The overlay is only rgba(0,0,0,0.6) — the filter is what actually hides the
	// pixels, so pinning the class without the rule would let a rename ship an
	// NSFW ref sheet that is plainly legible through the overlay.
	it('backs the blurred class with a real blur rule', () => {
		expect(pageSrc).toMatch(/\.ref-sheet img\.blurred\s*\{[^}]*filter:\s*blur\(/);
	});

	// The caption link is the only route onward while shielded, so it has to meet
	// AA — --primary does not on small text in ember light (SONA-162).
	it('gives the caption link the AA-safe token, not --primary', () => {
		expect(pageSrc).toMatch(/\.caption a\s*\{[^}]*color:\s*var\(--status-attention\)/);
	});
});
