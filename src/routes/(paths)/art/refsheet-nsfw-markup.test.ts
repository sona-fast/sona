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

	// Matched on the message keys and the href rather than whole tags, so
	// reformatting the (deliberately dense) caption line doesn't fail these.
	// Shielded, the caption is the ref sheet's only route onward — including for
	// visitors without JS, where the reveal button does nothing. It says "open in
	// the gallery" because that page shields the same image again.
	it('carries the route onward in the caption, and the full-size line otherwise', () => {
		const caption = pageSrc.match(/<p class="caption">[\s\S]*?<\/p>/)?.[0] ?? '';
		expect(caption).toMatch(/<a href=\{`\/gallery\/\$\{data\.refSheet\.slug\}`\}>\{m\.art_ref_open_gallery\(\)\}/);
		expect(caption).toContain('{m.art_ref_view_full()}');
	});

	// The separator between the two caption sentences lives in the en strings, not
	// in markup or CSS, so it reaches the accessibility tree and the clipboard —
	// and ja, which takes no space after 。, simply carries none.
	it('emits no markup whitespace between the caption sentences', () => {
		expect(pageSrc).toContain('{m.art_ref_caption()}{#if data.refSheet.nsfw && !revealed}');
	});

	// The overlay is only rgba(0,0,0,0.6) — the filter is what actually hides the
	// pixels, so pinning the class without the rule would let a rename ship an
	// NSFW ref sheet that is plainly legible through the overlay.
	it('backs the blurred class with a real blur rule', () => {
		expect(pageSrc).toMatch(/\.ref-sheet img\.blurred\s*\{[^}]*filter:\s*blur\(/);
	});

	// The reveal button is inset:0 absolute — without a positioned frame the
	// overlay anchors to some outer ancestor and detaches from the image it hides.
	it('positions the shielded frame so the overlay stays on the image', () => {
		expect(pageSrc).toMatch(/\.ref-sheet\.shielded\s*\{[^}]*position:\s*relative/);
	});

	// .ref-sheet clips overflow, so the negative offset is what keeps the keyboard
	// focus ring on screen at all.
	it('draws the reveal button focus ring inside the clipped frame', () => {
		const rule = pageSrc.match(/\.reveal-btn:focus-visible\s*\{[^}]*\}/)?.[0] ?? '';
		expect(rule).toMatch(/outline:\s*2px solid/);
		expect(rule).toMatch(/outline-offset:\s*-\d/);
	});

	// The caption link is the only route onward while shielded, so it has to meet
	// AA — --primary does not on small text in ember light (SONA-162).
	it('gives the caption link the AA-safe token, not --primary', () => {
		expect(pageSrc).toMatch(/\.caption a\s*\{[^}]*color:\s*var\(--status-attention\)/);
	});
});

// The en separator is a leading space inside the second sentence's own string.
// Nothing else renders these two keys, so a well-meaning trim would silently
// glue the sentences together in en — or add a space ja must not have.
describe('/art caption sentence separator (SONA-18)', () => {
	const en = JSON.parse(readFileSync(new URL('../../../../messages/en.json', import.meta.url), 'utf8'));
	const ja = JSON.parse(readFileSync(new URL('../../../../messages/ja.json', import.meta.url), 'utf8'));

	it('leads the en second sentence with a space', () => {
		expect(en.art_ref_view_full.startsWith(' ')).toBe(true);
		expect(en.art_ref_open_gallery.startsWith(' ')).toBe(true);
	});

	it('leads the ja second sentence with none', () => {
		expect(ja.art_ref_view_full.startsWith(' ')).toBe(false);
		expect(ja.art_ref_open_gallery.startsWith(' ')).toBe(false);
	});
});
