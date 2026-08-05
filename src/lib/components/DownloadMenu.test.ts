import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pinned wiring guard for the split download button (SONA-123), same
// pattern as gallery/[slug]/download-beacon.test.ts: no component test runner
// in this repo, so pin the behaviors that would otherwise die silently — the
// forced-download attributes, the metrics-beacon hook, the single-option
// collapse, and the caret's disclosure ARIA.
const src = readFileSync(new URL('./DownloadMenu.svelte', import.meta.url), 'utf8');

describe('DownloadMenu wiring (SONA-123)', () => {
	// The primary anchor is the one carrying href={options[0].href}; the menu-row
	// anchor carries href={option.href} inside the {#each}.
	const primaryAnchor = src.match(/<a(?=[^>]*href=\{options\[0\]\.href\})[^>]*>/)?.[0];
	const rowAnchor = src.match(/<a(?=[^>]*href=\{option\.href\})[^>]*>/)?.[0];

	it('both the primary anchor and the menu rows force a download', () => {
		// Dropping `download` turns the press into navigation to raw bytes.
		expect(primaryAnchor).toBeDefined();
		expect(primaryAnchor).toMatch(/\bdownload\b/);
		expect(rowAnchor).toBeDefined();
		expect(rowAnchor).toMatch(/\bdownload\b/);
	});

	it('every download press reaches the onDownload metrics hook', () => {
		// The primary anchor's inline handler contains '=>' which terminates the
		// tag-regex above early, so pin it on the whole source: the only inline
		// onDownload arrow in the file is the primary anchor's onclick.
		expect(src).toContain('onclick={() => onDownload?.()}');
		expect(rowAnchor).toContain('onclick={picked}');
		const picked = src.match(/function picked\(\)\s*\{[\s\S]*?\n\t\}/)?.[0];
		expect(picked).toBeDefined();
		expect(picked).toContain('onDownload?.()');
	});

	it('hasMenu derives from options.length > 1 and gates the caret and the list', () => {
		expect(src).toContain('const hasMenu = $derived(options.length > 1)');
		// The caret button and the list each render only under a hasMenu guard, so
		// a single-option sticker collapses to the plain pill button.
		const caretGuard = src.match(/\{#if hasMenu\}\s*<button/)?.[0];
		expect(caretGuard).toBeDefined();
		const listGuard = src.match(/\{#if hasMenu\}[\s\S]*?<ul/)?.[0];
		expect(listGuard).toBeDefined();
	});

	it('the caret uses disclosure ARIA (expanded/controls/label, NO haspopup)', () => {
		const caret = src.match(/<button(?=[^>]*class="[^"]*dl-caret)[^>]*>/)?.[0];
		expect(caret).toBeDefined();
		expect(caret).toContain('aria-expanded={open}');
		expect(caret).toContain('aria-controls={listId}');
		expect(caret).toContain('aria-label={menuLabel}');
		// Plain-links disclosure pattern, not a menu widget: aria-haspopup would
		// promise menu roles/arrow-key behavior the component doesn't implement.
		expect(caret).not.toContain('aria-haspopup');
	});

	it('the list persists (hidden when closed) so aria-controls never dangles', () => {
		const list = src.match(/<ul(?=[^>]*id=\{listId\})[^>]*>/)?.[0];
		expect(list).toBeDefined();
		expect(list).toContain('hidden={!open}');
	});

	it('open waits for the DOM flush (tick) before focusing the first row', () => {
		// A bare microtask ran before Svelte flipped `hidden`, leaving focus on the
		// caret — the tick() await is what makes focus-first-on-open real.
		const toggle = src.match(/function toggle\(\)\s*\{[\s\S]*?\n\t\}/)?.[0];
		expect(toggle).toBeDefined();
		expect(toggle).toContain('await tick()');
		expect(toggle).toContain("querySelector('a')?.focus()");
	});

	it('closes when focus leaves the widget (focusout on the wrapper)', () => {
		expect(src).toContain('onfocusout={onRootFocusout}');
		const focusout = src.match(/function onRootFocusout\([\s\S]*?\n\t\}/)?.[0];
		expect(focusout).toBeDefined();
		expect(focusout).toContain('close()');
	});
});
