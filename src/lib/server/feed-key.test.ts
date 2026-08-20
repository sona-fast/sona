import { describe, it, expect } from 'vitest';
import { mintFeedKey, feedKeyMatches } from './feed-key';

/** Alternating case, so the assertion cannot pass by folding one way only. */
const mixedCase = (s: string) =>
	Array.from(s, (c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');

describe('mintFeedKey', () => {
	it('mints 32 lowercase hex characters — a full 128 bits', () => {
		expect(mintFeedKey()).toMatch(/^[0-9a-f]{32}$/);
	});

	it('mints a different key every time', () => {
		// Not a randomness test (it cannot be one) — a guard against the obvious
		// regression of a constant or a seeded generator, which would hand every
		// fork in the fleet the same feed address.
		const keys = new Set(Array.from({ length: 50 }, mintFeedKey));
		expect(keys.size).toBe(50);
	});
});

describe('feedKeyMatches', () => {
	const stored = 'a'.repeat(32);

	it('accepts exactly the stored key', () => {
		expect(feedKeyMatches(stored, stored)).toBe(true);
	});

	it('rejects a key that differs anywhere', () => {
		expect(feedKeyMatches('b' + stored.slice(1), stored)).toBe(false);
		expect(feedKeyMatches(stored.slice(0, 31) + 'b', stored)).toBe(false);
	});

	it('rejects a wrong length, including a prefix of the real key', () => {
		expect(feedKeyMatches(stored.slice(0, 31), stored)).toBe(false);
		expect(feedKeyMatches(stored + 'a', stored)).toBe(false);
	});

	it('rejects an absent key', () => {
		expect(feedKeyMatches(null, stored)).toBe(false);
		expect(feedKeyMatches('', stored)).toBe(false);
	});

	it('never matches when no key has been minted', () => {
		// The case that matters most: a fork that has not opted in must not be
		// unlocked by `?key=` or a bare `?key`, both of which arrive as ''.
		expect(feedKeyMatches('', '')).toBe(false);
		expect(feedKeyMatches(null, '')).toBe(false);
		expect(feedKeyMatches('anything', '')).toBe(false);
	});

	// Hex was chosen over base64url so the key survives being retyped by hand.
	// That only pays off if the comparison folds case: otherwise a key copied
	// from a screenshot in capitals returns the plain SFW feed, which looks
	// exactly like a key that was revoked.
	it('accepts the stored key in any case', () => {
		expect(feedKeyMatches(stored.toUpperCase(), stored)).toBe(true);
		expect(feedKeyMatches(mixedCase(stored), stored)).toBe(true);
	});

	it('still rejects a wrong key regardless of case', () => {
		const wrong = stored.slice(0, -1) + (stored.endsWith('a') ? 'b' : 'a');
		expect(feedKeyMatches(wrong.toUpperCase(), stored)).toBe(false);
	});
});
