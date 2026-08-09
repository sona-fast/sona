import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	EARLY_ACCESS,
	isFeatureEnabled,
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

	it('lists only flags still inside their early-access window, with label keys', () => {
		EARLY_ACCESS.pilot = '2026-08-10';
		EARLY_ACCESS['multi-word-flag'] = '2026-08-05';

		expect(earlyAccessActive(BEFORE)).toEqual([
			{ flag: 'pilot', gaDate: '2026-08-10', labelKey: 'early_access_label_pilot' },
			{
				flag: 'multi-word-flag',
				gaDate: '2026-08-05',
				labelKey: 'early_access_label_multi_word_flag'
			}
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
	it('registers vr-avatars with a well-formed GA date', () => {
		// The exact date is release-process-owned (merge date + 7, set at merge),
		// so assert presence + shape, not the value.
		expect(Object.keys(SHIPPED)).toEqual(['vr-avatars']);
		expect(SHIPPED['vr-avatars']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
		for (const flag of Object.keys(SHIPPED)) {
			const key = earlyAccessLabelKey(flag);
			for (const { locale, messages } of locales) {
				expect(
					messages[key],
					`messages/${locale}.json is missing "${key}" — the settings page would fall back to the raw flag slug`
				).toBeTruthy();
			}
		}
	});

	it('labels vr-avatars per spec in both locales', () => {
		const read = (locale: string) =>
			JSON.parse(
				readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), 'utf-8')
			) as Record<string, string>;
		expect(read('en')['early_access_label_vr_avatars']).toBe('VR avatars');
		expect(read('ja')['early_access_label_vr_avatars']).toBe('VRアバター');
	});
});
