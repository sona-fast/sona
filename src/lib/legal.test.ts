import { describe, it, expect } from 'vitest';
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

	it('falls back to the defaults date for an override with no save stamp', () => {
		// e.g. a config-seeded override that never went through the admin editor.
		expect(legalUpdatedDate('Seeded policy.', '')).toBe(LEGAL_DEFAULTS_UPDATED);
	});

	it('exposes a valid YYYY-MM-DD defaults date', () => {
		expect(LEGAL_DEFAULTS_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
