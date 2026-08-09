import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
	defaultPrivacyPolicy,
	defaultTerms,
	legalUpdatedDate,
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
});

describe('defaultTerms', () => {
	it('returns non-empty sections and interpolates the site name', () => {
		const sections = defaultTerms(withEmail);
		expect(sections.length).toBeGreaterThan(0);
		const text = sections.flatMap((s) => s.body).join('\n');
		expect(text).toContain('Testsona');
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
	const RECORDED_TEXT_HASH = '29e991d6a419e3d7cfe8a8b2101abc29b919fcf054dc1ea7c8be4b5af3c6a8b4';

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
