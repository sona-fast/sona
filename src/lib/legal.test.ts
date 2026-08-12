import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
	defaultPrivacyPolicy,
	defaultTerms,
	legalUpdatedDate,
	splitParagraphs,
	LEGAL_DEFAULTS_UPDATED
} from './legal';

const withEmail = { siteName: 'Testsona', contactEmail: 'hi@test.example' };
const noEmail = { siteName: 'Testsona', contactEmail: '' };

describe('defaultPrivacyPolicy', () => {
	it('returns non-empty sections with headings and body paragraphs', () => {
		const sections = defaultPrivacyPolicy(withEmail);
		expect(sections.length).toBeGreaterThan(0);
		for (const s of sections) {
			expect(s.heading.length).toBeGreaterThan(0);
			expect(s.body.length).toBeGreaterThan(0);
			expect(s.body.every((p) => p.length > 0)).toBe(true);
		}
	});

	it('interpolates the site name and contact email', () => {
		const text = defaultPrivacyPolicy(withEmail)
			.flatMap((s) => s.body)
			.join('\n');
		expect(text).toContain('Testsona');
		expect(text).toContain('hi@test.example');
	});

	it('falls back to a generic contact phrase when no email is set', () => {
		const text = defaultPrivacyPolicy(noEmail)
			.flatMap((s) => s.body)
			.join('\n');
		expect(text).not.toContain('@');
		expect(text).toContain('contact options');
	});

	it('mentions CCPA/CPRA privacy rights', () => {
		const text = defaultPrivacyPolicy(withEmail)
			.flatMap((s) => [s.heading, ...s.body])
			.join('\n');
		expect(text).toMatch(/CPRA|California Consumer Privacy Act/);
	});

	// Guards against the policy drifting out of sync with the optional built-in
	// visitor analytics (issue #6/#149): if the feature ships but the disclosure
	// is dropped, this fails.
	it('conditionally discloses the built-in visitor analytics in "Information we collect"', () => {
		// Scope to the section, and match wording unique to the visitor-analytics
		// paragraph — not the pre-existing "third-party analytics cookies" line in
		// the same section, which also contains the word "analytics".
		const collect = defaultPrivacyPolicy(withEmail).find(
			(s) => s.heading === 'Information we collect'
		);
		expect(collect).toBeDefined();
		const text = (collect?.body ?? []).join('\n');
		// Framed as conditional, not something every site does.
		expect(text).toMatch(/If this site has visitor analytics enabled|Some sites/);
		// The four visitor counters are pruned after ~35 days (pruneVisitorRollups
		// in metrics.ts)...
		expect(text).toMatch(/35 days/);
		// ...while the download count is honestly a running total, not deleted.
		expect(text).toContain('running total');
	});

	// CalOPPA requires the policy to say how the site answers Do Not Track. Saying
	// nothing is a violation, and saying "we ignore it" is only defensible with the
	// reason attached — so both halves are pinned, not just the heading.
	it('discloses how DNT and GPC signals are handled, and why', () => {
		const section = defaultPrivacyPolicy(withEmail).find((s) => /Do Not Track/.test(s.heading));
		expect(section).toBeDefined();
		const text = (section?.body ?? []).join('\n');
		// Named signals, and the non-response stated plainly.
		expect(text).toContain('Global Privacy Control');
		expect(text).toMatch(/does not act on them/);
		// The rationale that makes the non-response lawful: nothing to opt out of.
		expect(text).toMatch(/do not sell or share personal information/);
		expect(text).toMatch(/cross-context behavioral advertising/);
	});

	// Guards against the service-providers list drifting from the email feature:
	// password resets go through Resend, which must be named as a processor.
	it('names Resend as the email delivery provider', () => {
		const text = defaultPrivacyPolicy(withEmail)
			.flatMap((s) => s.body)
			.join('\n');
		expect(text).toContain('Resend');
	});

	// SONA-167: the /ai disclosure page names Anthropic and CodeRabbit as
	// dev-time processors; /privacy must say the same or the two pages publicly
	// contradict each other on the trust question.
	it('names the AI development tools as dev-time processors', () => {
		const text = defaultPrivacyPolicy(withEmail)
			.flatMap((s) => s.body)
			.join('\n');
		expect(text).toContain('Claude');
		expect(text).toContain('CodeRabbit');
		// The runtime boundary, honestly scoped: nothing browsing-time goes to the
		// tools, but shared diagnostic logs can carry request data — both halves
		// must stay, or the paragraph overclaims again.
		expect(text).toMatch(/nothing you do here is sent to them as you browse/);
		expect(text).toMatch(/can contain request data such as IP addresses/);
	});

	// Cloudflare injects its Web Analytics beacon into proxied responses on
	// every fork (see the CSP allowance for static.cloudflareinsights.com);
	// "no third-party analytics cookies" alone reads as weasel wording to
	// anyone with a network tab open, so the script itself must be disclosed.
	it('discloses the Cloudflare Web Analytics script and the feature integrations', () => {
		const text = defaultPrivacyPolicy(withEmail)
			.flatMap((s) => s.body)
			.join('\n');
		expect(text).toMatch(/Web Analytics script/);
		// app.css imports web fonts from Google on every public page, so Google
		// is a recipient of visitor IPs whether or not we mention the beacon.
		expect(text).toMatch(/Google Fonts/);
		expect(text).toContain('Turnstile');
		expect(text).toContain('Telegram');
		expect(text).toContain('cons.fyi');
		// The integrations list reads exhaustive, so it must actually be: every
		// remote service a feature calls out to is named (SONA-167 round 1).
		expect(text).toContain('Bluesky');
		expect(text).toContain('FurTrack');
		expect(text).toMatch(/shared artist registry/);
	});
});

describe('defaultTerms', () => {
	it('returns non-empty sections and interpolates the site name', () => {
		const sections = defaultTerms(withEmail);
		expect(sections.length).toBeGreaterThan(0);
		const text = sections.flatMap((s) => s.body).join('\n');
		expect(text).toContain('Testsona');
	});
});

describe('splitParagraphs', () => {
	// Shared by the /privacy, /terms and /ai override paths, so a fix here (or a
	// regression) reaches all three at once.
	it('splits on blank lines and normalizes CRLF from textarea submissions', () => {
		expect(splitParagraphs('One.\r\n\r\nTwo.')).toEqual(['One.', 'Two.']);
	});

	it('keeps single newlines inside a paragraph (CSS renders them)', () => {
		expect(splitParagraphs('One.\nStill one.')).toEqual(['One.\nStill one.']);
	});

	it('trims surrounding blank space', () => {
		expect(splitParagraphs('\n\n  Only.  \n\n')).toEqual(['Only.']);
	});
});

describe('legalUpdatedDate', () => {
	// The "Last updated" line must come from a STABLE source, not `new Date()` at
	// render time — so a stock page (no override) always resolves to the fixed
	// per-release constant, never today's date.
	it('is the per-release defaults date when no override is set', () => {
		expect(legalUpdatedDate('', '2026-05-01')).toBe(LEGAL_DEFAULTS_UPDATED);
		expect(legalUpdatedDate('   ', '2026-05-01')).toBe(LEGAL_DEFAULTS_UPDATED);
	});

	it("is the owner's save stamp when an override is set", () => {
		expect(legalUpdatedDate('Our custom policy.', '2026-05-01')).toBe('2026-05-01');
	});

	it("returns '' (hides the line) for an override with no save stamp", () => {
		// e.g. a config-seeded override that never went through the admin editor: its
		// true edit date is unknown, so we hide the line rather than claim the
		// built-in defaults' date for custom text.
		expect(legalUpdatedDate('Seeded policy.', '')).toBe('');
	});

	it('exposes a valid YYYY-MM-DD defaults date', () => {
		expect(LEGAL_DEFAULTS_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe('LEGAL_DEFAULTS_UPDATED tracks the default text', () => {
	// LEGAL_DEFAULTS_UPDATED is the "Last updated" date every stock fork shows, so
	// it is only honest if it moves whenever the text does. Nothing enforced that
	// — the constant is hand-maintained and an edit that forgot it would ship a
	// stale date to every fork at once.
	//
	// So: pin a hash of the default text. Editing defaultPrivacyPolicy or
	// defaultTerms fails this test, and the fix is to bump the date constant AND
	// this hash in the same commit. Deliberately one assertion, not a diff — the
	// point is to force the date bump, not to review the prose.
	const RECORDED_TEXT_HASH = '6daa19684cf59f6756cc97bab4729b213b8e3f7cdcb9323b62aa963bf5b1a470';

	function defaultsText(): string {
		// Fixed opts so the hash depends on the prose alone, not the caller. Both
		// variants, so an edit to the no-email contact fallback moves the hash too.
		return [withEmail, noEmail]
			.flatMap((opts) => [...defaultPrivacyPolicy(opts), ...defaultTerms(opts)])
			.flatMap((s) => [s.heading, ...s.body])
			.join('\n');
	}

	it('has not changed without a date bump', () => {
		const actual = createHash('sha256').update(defaultsText()).digest('hex');
		expect(
			actual,
			'The default legal text changed. Bump LEGAL_DEFAULTS_UPDATED in src/lib/legal.ts ' +
				'and update RECORDED_TEXT_HASH here in the same commit.'
		).toBe(RECORDED_TEXT_HASH);
	});
});
