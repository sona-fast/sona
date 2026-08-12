import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Source-pins for the footer build receipt (SONA-167), per the
// nav-gating-markup.test.ts precedent: the receipt's behavior is baked in by
// vite define, so nothing executes these branches in unit tests, and a deleted
// conditional fails silently (dev builds simply never render the line).

const footerSrc = readFileSync(new URL('./Footer.svelte', import.meta.url), 'utf8');

describe('footer build receipt markup', () => {
	it('renders the receipt only when a build SHA was baked in', () => {
		expect(footerSrc).toMatch(/\{#if receipt\}/);
		expect(footerSrc).toMatch(/buildReceipt\(__BUILD_COMMIT_SHA__, __BUILD_REPO_URL__\)/);
	});

	it('links the SHA only when the building repo is known, plain text otherwise', () => {
		expect(footerSrc).toMatch(/\{#if receipt\.url\}\s*<a href=\{receipt\.url\}/);
		// The unlinked fallback stays a bare message, not a dead link.
		expect(footerSrc).toMatch(/\{:else\}\s*\{m\.footer_build\(\{ sha: receipt\.short \}\)\}/);
	});
});
