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
		expect(receiptSrc).toMatch(/\{#if receipt\.url && linked\}\s*<a\b[\s\S]*?href=\{receipt\.url\}/);
		// The unlinked fallback stays a bare message, not a dead link: pin the
		// discriminator (an else branch with no anchor), not the exact call.
		const elseBranch = receiptSrc.split('{:else}')[1]?.split('{/if}')[0] ?? '';
		expect(elseBranch).toMatch(/m\.footer_build\(/);
		expect(elseBranch).not.toMatch(/<a\b/);
	});

	// One atom, both chromes: Footer above 768px, MobileCredit below — so the
	// stamp the /ai page points at exists at every viewport.
	it('is rendered by both footer chromes, each passing the link gate', () => {
		expect(footerSrc).toContain('<BuildReceipt linked={settings.aiPageEnabled} />');
		expect(mobileCreditSrc).toContain('<BuildReceipt linked={settings.aiPageEnabled} />');
	});

	// Actions sets GITHUB_REPOSITORY regardless of repository visibility, so a
	// fork that declined the disclosure must not publish its repo path in the
	// footer markup or hand visitors a link into a private repo.
	it('shows the SHA unlinked when the disclosure is off', () => {
		expect(receiptSrc).toMatch(/let \{ linked = true \}/);
		const elseBranch = receiptSrc.split('{:else}')[1]?.split('{/if}')[0] ?? '';
		expect(elseBranch).toMatch(/m\.footer_build\(/);
		expect(elseBranch).not.toMatch(/<a\b/);
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

describe('feed link gating markup (SONA-172)', () => {
	// Same rule as the /ai link above: a fork that turned the feed off gets
	// neither the link nor the route. Below 768px the desktop Footer is
	// display:none, so MobileCredit needs its own copy or phone visitors could
	// never reach the feed.
	it('wraps the feed link in the rssFeedEnabled conditional in both chromes', () => {
		expect(footerSrc).toMatch(/\{#if settings\.rssFeedEnabled\}\s*<a href="\/feed\.xml"/);
		expect(mobileCreditSrc).toMatch(/\{#if settings\.rssFeedEnabled\}\s*<a href="\/feed\.xml"/);
	});

	// Only ever the SFW address. The keyed edition is private by construction, so
	// a footer or autodiscovery link carrying `?key=` would publish it to every
	// visitor of every page.
	it('never points a public link at a keyed feed address', () => {
		const rootLayout = readFileSync(new URL('../../routes/+layout.svelte', import.meta.url), 'utf8');
		for (const src of [footerSrc, mobileCreditSrc, rootLayout]) {
			expect(src).not.toMatch(/feed\.xml\?/);
		}
	});

	it('advertises the feed for autodiscovery from the ROOT layout, behind the toggle', () => {
		// The (public) layout would miss the homepage, which is +page@.svelte and
		// escapes it — and the homepage is exactly where a reader's "find the feed"
		// button looks.
		const rootLayout = readFileSync(new URL('../../routes/+layout.svelte', import.meta.url), 'utf8');
		expect(rootLayout).toMatch(
			/\{#if data\.rssFeedEnabled\}[\s\S]*?rel="alternate"[\s\S]*?type="application\/rss\+xml"/
		);
	});

	// Four links no longer fit one 320px row at 200% zoom. Without wrapping the
	// alternative is a horizontally scrolled footer (WCAG 1.4.4 / 1.4.10).
	it('lets the mobile link row wrap', () => {
		const legalLinks = mobileCreditSrc.match(/\.legal-links \{([\s\S]*?)\}/)?.[1] ?? '';
		expect(legalLinks).toMatch(/flex-wrap:\s*wrap/);
	});

	// The nav holds more than legal pages now, so the group's accessible name has
	// to describe what is actually in it.
	it('labels the link nav as site links, not legal', () => {
		for (const path of localePaths) {
			const messages = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
			expect(messages.footer_rss, `${path.pathname} footer_rss`).toBeTruthy();
			expect(messages.footer_legal_label, `${path.pathname} footer_legal_label`).toBeTruthy();
		}
		// Truthiness alone would stay green if the label reverted to "Legal", which
		// is the whole regression: pin the en value, and pin that both chromes name
		// the nav from that key rather than from a literal.
		const en = JSON.parse(readFileSync(localePaths[0], 'utf8')) as Record<string, string>;
		expect(en.footer_legal_label).toBe('Site links');
		for (const src of [footerSrc, mobileCreditSrc]) {
			expect(src).toMatch(/<nav class="legal-links" aria-label=\{m\.footer_legal_label\(\)\}/);
		}
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
