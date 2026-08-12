import { describe, it, expect } from 'vitest';
import { defaultAiDisclosure } from './ai-disclosure';

// Pins the operator-approved disclosure claims (SONA-167). Each assertion
// guards a fact the page must keep stating exactly as long as it is true —
// and force a conscious edit here the day any of them stops being true.

describe('defaultAiDisclosure', () => {
	const d = defaultAiDisclosure();
	const all = [d.intro, ...d.topics.flatMap((t) => [t.lead, t.body]), d.closer].join('\n');

	it('opens by disclosing, not persuading', () => {
		expect(d.intro).toMatch(/built and written with AI/);
	});

	it('names the coding tool and the human gate', () => {
		expect(all).toContain('Claude Code');
		expect(all).toMatch(/I review and approve every change/);
	});

	it('discloses AI-drafted text, including the page itself', () => {
		// The peer-review catch that reshaped this page: a disclosure written by
		// AI may never claim the site has no generated text.
		expect(all).toMatch(/including this page, were drafted with AI/);
	});

	it('scopes the art claim to what the operator can vouch for', () => {
		expect(all).toMatch(/commissioned from human artists and credited/);
		expect(all).toMatch(/purchased base models/);
	});

	it('states the runtime boundary and the dev-time access plainly', () => {
		expect(all).toMatch(/never calls an AI service/);
		expect(all).toMatch(/logs and database/);
		expect(all).toContain('CodeRabbit');
		// Honesty about what dev-time log access can expose: no "your data never
		// touches AI" overclaim while the logs those tools read carry visitor IPs.
		expect(all).toMatch(/logs can include visitors' IP addresses and the pages they requested/);
	});

	it('scopes the no-training claim to the plan terms, not a warranty', () => {
		expect(all).toMatch(/plans set not to train on my data/);
	});

	it('concedes the training-data provenance without arguing it', () => {
		expect(all).toMatch(/can't vouch for how it was gathered/);
	});

	it('commits to keeping the page current and points at the build receipt', () => {
		expect(d.closer).toMatch(/this page changes with it/);
		// Conditional on purpose: the receipt only renders on real Actions builds,
		// so the closer must not promise a footer link every deployment shows.
		expect(d.closer).toMatch(/When the footer shows a build number/);
		expect(d.closer).toMatch(/links to the source this exact build came from/);
	});
});
