import { describe, it, expect } from 'vitest';
import { resolveLicense, LICENSES, type LicenseKey } from './license';

// resolveLicense is the security boundary for fursuit-photo exposure: a stored
// row is only ever rendered if its license is `displayable`. The tests below
// pin the confirmed mappings AND, more importantly, prove that EVERY unmapped
// input falls through to LICENSES.unknown (which is not displayable). If a
// future edit accidentally inverts that default, this suite fails loudly.

describe('resolveLicense', () => {
	// FurTrack's `postCopyright` integer codes confirmed against live posts
	// (see license.ts). Anything not in this table must resolve to `unknown`.
	const CONFIRMED: Array<[number, LicenseKey]> = [
		[1, 'photographer-discretion'],
		[2, 'cc-by-nc-nd'],
		[3, 'cc-by-nc'],
		[4, 'cc-by-nd'],
		[5, 'cc-by'],
		[6, 'photographer-license'],
		[10, 'public-domain']
	];

	describe('confirmed integer codes', () => {
		for (const [code, key] of CONFIRMED) {
			it(`code ${code} → ${key}`, () => {
				expect(resolveLicense(code)).toBe(LICENSES[key]);
			});
			it(`numeric string "${code}" resolves the same as the integer`, () => {
				expect(resolveLicense(String(code))).toBe(LICENSES[key]);
			});
		}
	});

	describe('fail-closed: every unmapped integer → unknown (not displayable)', () => {
		// The current gaps in the enum (0, 7, 8, 9), plus a wide fuzz range,
		// negatives, and values far outside FurTrack's enum space. If FurTrack
		// adds a new code and we don't map it, the photo MUST stay hidden.
		const FUZZ = [
			0, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 50, 100, 999, 9999,
			-1, -10, Number.MAX_SAFE_INTEGER
		];
		for (const n of FUZZ) {
			it(`integer ${n} → unknown (not displayable)`, () => {
				const r = resolveLicense(n);
				expect(r).toBe(LICENSES.unknown);
				expect(r.displayable).toBe(false);
			});
		}
	});

	describe('nullish, garbage, and non-numeric strings → unknown', () => {
		const GARBAGE: Array<string | null | undefined> = [
			null,
			undefined,
			'',
			'   ',
			'nonsense',
			'CC-BY-LATER',
			'1.5',
			'5.0',
			'0x5',
			'NaN',
			'5x',
			'license-3',
			'unknown',
			'all rights reserved' // present as a label, but verifies the lowercase alias works (NOT displayable)
		];
		for (const v of GARBAGE) {
			it(`${JSON.stringify(v)} → not displayable`, () => {
				expect(resolveLicense(v).displayable).toBe(false);
			});
		}
	});

	describe('textual label aliases (case + spacing tolerated)', () => {
		const LABELS: Array<[string, LicenseKey]> = [
			['cc-by', 'cc-by'],
			['CC BY', 'cc-by'],
			['cc-by-nd', 'cc-by-nd'],
			['cc-by-nc', 'cc-by-nc'],
			['cc-by-nc-nd', 'cc-by-nc-nd'],
			['Public Domain', 'public-domain'],
			['public-domain', 'public-domain'],
			["Photographer's discretion", 'photographer-discretion'],
			['photographer discretion', 'photographer-discretion'],
			["Photographer's license", 'photographer-license'],
			['photographer license', 'photographer-license'],
			['All Rights Reserved', 'all-rights-reserved'],
			['© All Rights Reserved', 'all-rights-reserved']
		];
		for (const [label, key] of LABELS) {
			it(`"${label}" → ${key}`, () => {
				expect(resolveLicense(label)).toBe(LICENSES[key]);
			});
		}
	});

	describe('displayable invariant — only CC + Public Domain are displayable', () => {
		const DISPLAYABLE: ReadonlySet<LicenseKey> = new Set([
			'cc-by',
			'cc-by-nd',
			'cc-by-nc',
			'cc-by-nc-nd',
			'public-domain'
		]);
		for (const key of Object.keys(LICENSES) as LicenseKey[]) {
			it(`LICENSES["${key}"].displayable matches the expected set`, () => {
				expect(LICENSES[key].displayable).toBe(DISPLAYABLE.has(key));
			});
		}
	});
});
