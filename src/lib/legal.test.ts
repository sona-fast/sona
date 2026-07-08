import { describe, it, expect } from 'vitest';
import { defaultPrivacyPolicy, defaultTerms } from './legal';

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
