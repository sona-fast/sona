import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the footer chrome added by SONA-167, per the
// nav-gating-markup.test.ts precedent: the receipt's behavior is baked in by
// vite define, so nothing executes these branches in unit tests, and a deleted
// conditional fails silently (dev builds simply never render the line).

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const localePaths = ['en', 'ja'].map((l) => new URL(`../../../messages/${l}.json`, import.meta.url));
const receiptSrc = read('./BuildReceipt.svelte');
const footerSrc = read('./Footer.svelte');
const mobileCreditSrc = read('./MobileCredit.svelte');

describe('build receipt markup', () => {
	it('renders only when a build SHA was baked in', () => {
		expect(receiptSrc).toMatch(/\{#if receipt\}/);
		expect(receiptSrc).toMatch(/buildReceipt\(__BUILD_COMMIT_SHA__, __BUILD_REPO_URL__\)/);
	});

	it('links the SHA only when the building repo is known, plain text otherwise', () => {
		expect(receiptSrc).toMatch(/\{#if receipt\.url\}\s*<a\b[\s\S]*?href=\{receipt\.url\}/);
		// The unlinked fallback stays a bare message, not a dead link: pin the
		// discriminator (an else branch with no anchor), not the exact call.
		const elseBranch = receiptSrc.split('{:else}')[1]?.split('{/if}')[0] ?? '';
		expect(elseBranch).toMatch(/m\.footer_build\(/);
		expect(elseBranch).not.toMatch(/<a\b/);
	});

	// One atom, both chromes: Footer above 768px, MobileCredit below — so the
	// stamp the /ai page points at exists at every viewport.
	it('is rendered by both footer chromes', () => {
		expect(footerSrc).toContain('<BuildReceipt />');
		expect(mobileCreditSrc).toContain('<BuildReceipt />');
	});
});

describe('AI-page link gating markup', () => {
	// The /ai link must disappear with the toggle (SONA-167): a fork that turned
	// the page off gets neither the link nor the route. Below 768px the desktop
	// Footer is display:none, so MobileCredit needs the same gated link or phone
	// visitors could never reach the disclosure.
	it('wraps the AI link in the aiPageEnabled conditional in both chromes', () => {
		expect(footerSrc).toMatch(/\{#if settings\.aiPageEnabled\}\s*<a href="\/ai"/);
		expect(mobileCreditSrc).toMatch(/\{#if settings\.aiPageEnabled\}\s*<a href="\/ai"/);
	});
});

describe('build receipt accessible name', () => {
	// WCAG 2.5.3 Label in Name: the link's accessible name must contain its
	// visible text, or speech input ("click build") cannot activate it. The two
	// strings live in separate catalog entries, so editing one alone would
	// regress this silently in one locale — pin every locale.
	it('starts with the visible label in every locale', () => {
		for (const path of localePaths) {
			const messages = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
			const visible = messages.footer_build;
			const accessible = messages.footer_build_link_label;
			expect(visible, `${path.pathname} footer_build`).toBeTruthy();
			expect(accessible, `${path.pathname} footer_build_link_label`).toBeTruthy();
			// Compare on the interpolation-stripped stem so {sha} placement can't
			// mask a mismatch.
			const stem = visible.replace('{sha}', '').trim();
			expect(accessible.startsWith(visible.split('{sha}')[0])).toBe(true);
			expect(accessible).toContain(stem);
		}
	});
});
