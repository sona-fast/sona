import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	EARLY_ACCESS,
	isFeatureEnabled,
	featureOpenToEveryone,
	earlyAccessActive,
	earlyAccessLabelKey
} from './early-access';

// The gating tests seed their own flags, so they start from a cleared registry
// and restore the shipped entries afterwards. The shipped entries themselves
// (and their label-message invariants) are covered in 'shipped registry' below.
const SHIPPED = { ...EARLY_ACCESS };
beforeEach(() => {
	for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
});
afterEach(() => {
	for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
	Object.assign(EARLY_ACCESS, SHIPPED);
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
	it('is empty when nothing is registered', () => {
		expect(earlyAccessActive(BEFORE)).toEqual([]);
	});

	it('lists only flags still inside their early-access window', () => {
		EARLY_ACCESS.pilot = '2026-08-10';
		EARLY_ACCESS['multi-word-flag'] = '2026-08-05';

		expect(earlyAccessActive(BEFORE)).toEqual([
			{ flag: 'pilot', gaDate: '2026-08-10' },
			{ flag: 'multi-word-flag', gaDate: '2026-08-05' }
		]);
		// Past its GA date → no longer "active" (it's on for everyone).
		expect(earlyAccessActive(AFTER)).toEqual([]);
	});
});

describe('earlyAccessLabelKey', () => {
	it('flattens the flag slug into a message id', () => {
		expect(earlyAccessLabelKey('vr-avatars')).toBe('early_access_label_vr_avatars');
		expect(earlyAccessLabelKey('plain')).toBe('early_access_label_plain');
	});
});

describe('shipped registry', () => {
	it('holds only well-formed GA dates', () => {
		// Empty since vr-avatars retired (SONA-157). The shape check keeps
		// guarding whatever the next release registers.
		for (const gaDate of Object.values(SHIPPED)) {
			expect(gaDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	it('has a localized display label in every message file for every flag', () => {
		// The settings status line must never show the raw flag slug — each
		// registered flag needs its by-convention label message in both locales.
		const locales = ['en', 'ja'].map((locale) => ({
			locale,
			messages: JSON.parse(
				readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), 'utf-8')
			) as Record<string, string>
		}));
		// The invariant as a predicate, so it can be proven armed against
		// fabricated inputs even while SHIPPED is empty (SONA-157).
		const missingLabels = (flags: string[], files: typeof locales) =>
			flags.flatMap((flag) =>
				files
					.filter(({ messages }) => !messages[earlyAccessLabelKey(flag)])
					.map(({ locale }) => `messages/${locale}.json is missing "${earlyAccessLabelKey(flag)}"`)
			);
		// Armed: a flag without messages is caught in both locales…
		expect(missingLabels(['fabricated-flag'], locales)).toHaveLength(2);
		// …and a flag whose label exists in both files passes.
		const injected = ['en', 'ja'].map((locale) => ({
			locale,
			messages: { [earlyAccessLabelKey('fabricated-flag')]: 'Label' }
		}));
		expect(missingLabels(['fabricated-flag'], injected)).toEqual([]);
		// The real invariant, over whatever the next release registers.
		expect(missingLabels(Object.keys(SHIPPED), locales)).toEqual([]);
	});
});

describe('featureOpenToEveryone', () => {
	// The predicate an enforcement path uses to decide it needn't read a key at
	// all, so it must agree with isFeatureEnabled's key-independent branches.
	it('is true only when no supporter key could change the answer', () => {
		EARLY_ACCESS['probe'] = '2026-08-17';
		const before = new Date('2026-08-16T23:59:59Z');
		const after = new Date('2026-08-17T00:00:00Z');

		expect(featureOpenToEveryone('probe', before)).toBe(false);
		expect(isFeatureEnabled('probe', { supporterKeyValid: true, now: before })).toBe(true);

		expect(featureOpenToEveryone('probe', after)).toBe(true);
		expect(featureOpenToEveryone('never-registered', before)).toBe(true);
	});
});
