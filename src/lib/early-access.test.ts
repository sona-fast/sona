import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	EARLY_ACCESS,
	isFeatureEnabled,
	featureOpenToEveryone,
	earlyAccessActive,
	earlyAccessLabel,
	earlyAccessLabelKey,
	type EarlyAccessLabel
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

// Seeded entries need a label because the entry type requires one (that
// requirement is the SONA-169 fix: a statically referenced message per flag,
// so no computed lookup pins the whole catalog). The gating tests never read
// labels, so they share this one plain entry; the locale-aware stub lives in
// the earlyAccessLabel test that proves the options threading.
const PILOT = { gaDate: '2026-08-10', label: () => 'Pilot' };

const BEFORE = new Date('2026-08-01T00:00:00Z');
const ON_GA = new Date('2026-08-10T00:00:00Z');
const AFTER = new Date('2026-08-20T00:00:00Z');

describe('isFeatureEnabled', () => {
	it('is on for a flag not in the registry (never gated)', () => {
		expect(isFeatureEnabled('unlisted', { supporterKeyValid: false, now: BEFORE })).toBe(true);
	});

	it('is off before GA without a valid supporter key', () => {
		EARLY_ACCESS.pilot = PILOT;
		expect(isFeatureEnabled('pilot', { supporterKeyValid: false, now: BEFORE })).toBe(false);
	});

	it('is on before GA with a valid supporter key', () => {
		EARLY_ACCESS.pilot = PILOT;
		expect(isFeatureEnabled('pilot', { supporterKeyValid: true, now: BEFORE })).toBe(true);
	});

	it('is on for everyone on and after the GA date', () => {
		EARLY_ACCESS.pilot = PILOT;
		expect(isFeatureEnabled('pilot', { supporterKeyValid: false, now: ON_GA })).toBe(true);
		expect(isFeatureEnabled('pilot', { supporterKeyValid: false, now: AFTER })).toBe(true);
	});
});

describe('earlyAccessActive', () => {
	it('is empty when nothing is registered', () => {
		expect(earlyAccessActive(BEFORE)).toEqual([]);
	});

	it('lists only flags still inside their early-access window', () => {
		EARLY_ACCESS.pilot = PILOT;
		EARLY_ACCESS['multi-word-flag'] = { gaDate: '2026-08-05', label: () => 'Multi' };

		expect(earlyAccessActive(BEFORE)).toEqual([
			{ flag: 'pilot', gaDate: '2026-08-10' },
			{ flag: 'multi-word-flag', gaDate: '2026-08-05' }
		]);
		// Past its GA date → no longer "active" (it's on for everyone).
		expect(earlyAccessActive(AFTER)).toEqual([]);
	});
});

describe('earlyAccessLabel', () => {
	// The settings page's supporter status line renders each early-access flag
	// through this resolver (SONA-124 item: never the raw slug). The registry is
	// empty since vr-avatars retired (SONA-157), so the positive cases seed a
	// stub entry; 'shipped registry' below keeps real entries labeled in both
	// locale files.
	// Locale-aware stub: this is the one test that reads the label per-locale.
	const stubLabel: EarlyAccessLabel = (_inputs, options) =>
		options?.locale === 'ja' ? 'パイロット' : 'Pilot';

	it('resolves the entry label and threads the locale option', () => {
		EARLY_ACCESS.pilot = { gaDate: '2026-08-10', label: stubLabel };
		expect(earlyAccessLabel('pilot', { locale: 'en' })).toBe('Pilot');
		expect(earlyAccessLabel('pilot', { locale: 'ja' })).toBe('パイロット');
	});

	it('falls back to the flag slug for an unregistered flag', () => {
		expect(earlyAccessLabel('flag-without-entry', { locale: 'en' })).toBe('flag-without-entry');
	});

	it('falls back to the slug for prototype-named flags too', () => {
		// A bare bracket lookup would reach Object.prototype here and throw on
		// entry.label; Object.hasOwn keeps the documented slug fallback.
		expect(earlyAccessLabel('constructor', { locale: 'en' })).toBe('constructor');
		expect(earlyAccessLabel('toString')).toBe('toString');
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
		// Empty since vr-avatars retired (SONA-157). Armed against a fabricated
		// malformed date so the shape check cannot rot while the registry is
		// empty; the loop guards whatever the next release registers.
		const shape = /^\d{4}-\d{2}-\d{2}$/;
		expect('17-08-2026').not.toMatch(shape);
		for (const entry of Object.values(SHIPPED)) {
			expect(entry.gaDate).toMatch(shape);
		}
	});

	it('has a localized display label in every message file for every flag', () => {
		// The settings status line must never show the raw flag slug — each
		// registered flag needs its by-convention label message in both locales
		// (the entry's `label` is compiled from that message id).
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
		// Armed: a flag without messages is caught in both locales, so the
		// invariant below cannot pass vacuously by never matching anything.
		expect(missingLabels(['fabricated-flag'], locales)).toHaveLength(2);
		// The real invariant, over whatever the next release registers.
		expect(missingLabels(Object.keys(SHIPPED), locales)).toEqual([]);
	});

	it('renders each label as exactly its message text in both locales', () => {
		// The entry's `label` must be the compiled function of its by-convention
		// message id, not some other message: its output must equal the raw JSON
		// text (early-access labels take no inputs, so direct equality holds).
		// Vacuous while the registry is empty; arms as soon as a flag registers.
		for (const locale of ['en', 'ja'] as const) {
			const messages = JSON.parse(
				readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), 'utf-8')
			) as Record<string, string>;
			for (const [flag, entry] of Object.entries(SHIPPED)) {
				expect(entry.label({}, { locale })).toBe(messages[earlyAccessLabelKey(flag)]);
			}
		}
	});
});

describe('featureOpenToEveryone', () => {
	// The predicate an enforcement path uses to decide it needn't read a key at
	// all, so it must agree with isFeatureEnabled's key-independent branches.
	it('is true only when no supporter key could change the answer', () => {
		EARLY_ACCESS['probe'] = { gaDate: '2026-08-17', label: () => 'Probe' };
		const before = new Date('2026-08-16T23:59:59Z');
		const after = new Date('2026-08-17T00:00:00Z');

		expect(featureOpenToEveryone('probe', before)).toBe(false);
		expect(isFeatureEnabled('probe', { supporterKeyValid: true, now: before })).toBe(true);

		expect(featureOpenToEveryone('probe', after)).toBe(true);
		expect(featureOpenToEveryone('never-registered', before)).toBe(true);
	});
});
