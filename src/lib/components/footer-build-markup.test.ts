import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the footer chrome added by SONA-167, per the
// nav-gating-markup.test.ts precedent: the receipt's behavior is baked in by
// vite define, so nothing executes these branches in unit tests, and a deleted
// conditional fails silently (dev builds simply never render the line).

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
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
		// The unlinked fallback stays a bare message, not a dead link.
		expect(receiptSrc).toMatch(/\{:else\}\s*\{m\.footer_build\(\{ sha: receipt\.short \}\)\}/);
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
