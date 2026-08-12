import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the footer build receipt (SONA-167), per the
// nav-gating-markup.test.ts precedent: the receipt's behavior is baked in by
// vite define, so nothing executes these branches in unit tests, and a deleted
// conditional fails silently (dev builds simply never render the line).

const footerSrc = readFileSync(new URL('./Footer.svelte', import.meta.url), 'utf8');
const mobileCreditSrc = readFileSync(new URL('./MobileCredit.svelte', import.meta.url), 'utf8');

describe('footer build receipt markup', () => {
	it('renders the receipt only when a build SHA was baked in', () => {
		expect(footerSrc).toMatch(/\{#if receipt\}/);
		expect(footerSrc).toMatch(/buildReceipt\(__BUILD_COMMIT_SHA__, __BUILD_REPO_URL__\)/);
	});

	it('links the SHA only when the building repo is known, plain text otherwise', () => {
		expect(footerSrc).toMatch(/\{#if receipt\.url\}\s*<a\b[\s\S]*?href=\{receipt\.url\}/);
		// The unlinked fallback stays a bare message, not a dead link.
		expect(footerSrc).toMatch(/\{:else\}\s*\{m\.footer_build\(\{ sha: receipt\.short \}\)\}/);
	});
});

describe('footer AI-page link gating markup', () => {
	// The /ai footer link must disappear with the toggle (SONA-167): a fork
	// that turned the page off gets neither the link nor the route, together.
	it('wraps the AI link in the aiPageEnabled conditional', () => {
		expect(footerSrc).toMatch(/\{#if settings\.aiPageEnabled\}\s*<a href="\/ai"/);
	});
});

describe('mobile credit markup', () => {
	// Below 768px the desktop Footer is display:none and MobileCredit is the
	// ONLY footer chrome — so the /ai link and the build receipt must exist
	// there too, with the same gating, or phone visitors can never reach them.
	it('carries the gated /ai link', () => {
		expect(mobileCreditSrc).toMatch(/\{#if settings\.aiPageEnabled\}\s*<a href="\/ai"/);
	});

	it('renders the build receipt with the same linked/unlinked split as Footer', () => {
		expect(mobileCreditSrc).toMatch(/buildReceipt\(__BUILD_COMMIT_SHA__, __BUILD_REPO_URL__\)/);
		expect(mobileCreditSrc).toMatch(/\{#if receipt\}/);
		expect(mobileCreditSrc).toMatch(/\{#if receipt\.url\}\s*<a\b/);
		expect(mobileCreditSrc).toMatch(/\{:else\}\s*\{m\.footer_build\(\{ sha: receipt\.short \}\)\}/);
	});
});
