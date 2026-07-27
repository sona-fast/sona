import { describe, it, expect, afterEach } from 'vitest';
import { EARLY_ACCESS, isFeatureEnabled, earlyAccessActive } from './early-access';

// The registry ships empty; these tests seed a flag to exercise the gating logic
// and clean up after themselves so the shipped-empty invariant is preserved.
afterEach(() => {
	for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
});

const BEFORE = new Date('2026-08-01T00:00:00Z');
const ON_GA = new Date('2026-08-10T00:00:00Z');
const AFTER = new Date('2026-08-20T00:00:00Z');

describe('isFeatureEnabled', () => {
	it('is on for a flag not in the registry (never gated)', () => {
		expect(isFeatureEnabled('unlisted', { supporterKeyValid: false, now: BEFORE })).toBe(true);
	});

	it('is off before GA without a valid supporter key', () => {
		EARLY_ACCESS.pilot = '2026-08-10';
		expect(isFeatureEnabled('pilot', { supporterKeyValid: false, now: BEFORE })).toBe(false);
	});

	it('is on before GA with a valid supporter key', () => {
		EARLY_ACCESS.pilot = '2026-08-10';
		expect(isFeatureEnabled('pilot', { supporterKeyValid: true, now: BEFORE })).toBe(true);
	});

	it('is on for everyone on and after the GA date', () => {
		EARLY_ACCESS.pilot = '2026-08-10';
		expect(isFeatureEnabled('pilot', { supporterKeyValid: false, now: ON_GA })).toBe(true);
		expect(isFeatureEnabled('pilot', { supporterKeyValid: false, now: AFTER })).toBe(true);
	});
});

describe('earlyAccessActive', () => {
	it('is empty when nothing is registered (shipped-empty default)', () => {
		expect(earlyAccessActive(BEFORE)).toEqual([]);
	});

	it('lists only flags still inside their early-access window', () => {
		EARLY_ACCESS.pilot = '2026-08-10';
		EARLY_ACCESS.shipped = '2026-08-05';

		expect(earlyAccessActive(BEFORE)).toEqual([
			{ flag: 'pilot', gaDate: '2026-08-10' },
			{ flag: 'shipped', gaDate: '2026-08-05' }
		]);
		// Past its GA date → no longer "active" (it's on for everyone).
		expect(earlyAccessActive(AFTER)).toEqual([]);
	});
});
