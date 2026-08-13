import { describe, it, expect } from 'vitest';
import { defaultAiDisclosure } from './ai-disclosure';

// Pins the operator-approved disclosure claims (SONA-167). Each assertion
// guards a fact the page must keep stating exactly as long as it is true —
// and force a conscious edit here the day any of them stops being true.

describe('defaultAiDisclosure', () => {
	const d = defaultAiDisclosure();
	const all = [d.intro, ...d.topics.flatMap((t) => [t.lead, t.body]), d.closer].join('\n');

	it('opens by disclosing, not persuading', () => {
		expect(d.intro).toMatch(/runs on Sona, which is built with AI coding tools/);
	});

	it('names the coding tool and the human gate', () => {
		expect(all).toContain('Claude Code');
		// Third person, and naming the maker: on a fork the first-person version
		// read as though the site's owner had built Sona (fork-owner feedback).
		expect(all).toMatch(/made by the Sona Team, not by the person who runs this site/);
		expect(all).toMatch(/They review and approve every change/);
	});

	it('discloses AI-drafted text, including the page itself', () => {
		// The peer-review catch that reshaped this page: a disclosure written by
		// AI may never claim the site has no generated text.
		expect(all).toMatch(/including this page, was drafted with AI and edited by the Sona Team/);
	});

	it('scopes the art claim to what the operator can vouch for', () => {
		expect(all).toMatch(/commissioned from human artists and credited/);
		expect(all).toMatch(/purchased base models/);
	});

	it('states the runtime boundary and the dev-time access plainly', () => {
		expect(all).toMatch(/never calls an AI service, so nothing you do is sent to one as you browse/);
		expect(all).toMatch(/logs and database/);
		expect(all).toContain('CodeRabbit');
		// Honesty about what dev-time log access can expose: no "your data never
		// touches AI" overclaim while the logs those tools read carry visitor IPs.
		expect(all).toMatch(/logs can include visitors' IP addresses and the pages they requested/);
	});

	it('rests the no-training claim on the account setting and the vendor’s own statement', () => {
		// Not a warranty about what either company does in general, and not a
		// property of a "plan" either: on Anthropic's side it is an account
		// setting the owner switches off, and on CodeRabbit's it is what the
		// service says about its own reviews. Naming the mechanism is what makes
		// the claim one an owner can actually stand behind.
		expect(all).toMatch(/Model training is switched off on the accounts used/);
		expect(all).toMatch(/CodeRabbit states that the data from its reviews is never used for training/);
	});

	it('concedes the training-data provenance without arguing it', () => {
		expect(all).toMatch(/how it was gathered isn't something anyone here can vouch for/);
	});

	it('commits to keeping the page current and points at the build receipt', () => {
		expect(d.closer).toMatch(/this page changes with it/);
		// Conditional on purpose: the receipt only renders on real Actions builds,
		// so the closer must not promise a footer link every deployment shows.
		expect(d.closer).toMatch(/When the footer shows a build number/);
		expect(d.closer).toMatch(/links to the source this exact build came from/);
	});
});
