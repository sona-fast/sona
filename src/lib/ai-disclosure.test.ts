import { describe, it, expect } from 'vitest';
import { defaultAiDisclosure } from './ai-disclosure';

describe('defaultAiDisclosure', () => {
	const d = defaultAiDisclosure();

	it('routes vulnerability reports to the upstream private channels (SONA-171)', () => {
		const segments = d.security.body;
		const text = segments.map((s) => (typeof s === 'string' ? s : s.text)).join('');
		const hrefs = segments.flatMap((s) => (typeof s === 'string' ? [] : [s.href]));

		expect(d.security.lead).toBe('Security problems.');
		expect(text).toMatch(/report it privately/);
		// The human-facing entries for the channels /.well-known/security.txt
		// lists: the GitHub Security tab here versus the /security/advisories/new
		// report form there — a deliberate split, not drift. Never the public
		// issue tracker (a vulnerability in a public issue is itself a
		// disclosure), and never the fork operator (they can't fix a platform bug).
		expect(hrefs).toEqual([
			'https://github.com/sona-fast/sona/security',
			'mailto:security@sona.fast'
		]);
		expect(text).toMatch(/posting details publicly exposes all of them before a fix exists/);
	});
});
