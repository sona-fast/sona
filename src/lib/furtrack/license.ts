// FurTrack per-photo copyright/license handling.
//
// FurTrack lets each photographer pick a copyright option per photo. We mirror
// those options here and decide which ones sparky.ink may display publicly.
//
// Rule for this (non-commercial, no-edits) site: a photo is shown publicly ONLY
// if its license explicitly permits reposting — i.e. any Creative Commons option
// or Public Domain. Everything else (All Rights Reserved, or unspecified) is
// hidden unless the photographer gives direct permission.
//
// `terms` strings are copied verbatim from FurTrack's own upload dropdown so we
// never misrepresent a license.

export type LicenseKey =
	| 'cc-by'
	| 'cc-by-nd'
	| 'cc-by-nc'
	| 'cc-by-nc-nd'
	| 'public-domain'
	| 'photographer-discretion'
	| 'photographer-license'
	| 'all-rights-reserved'
	| 'unknown';

export interface LicenseInfo {
	key: LicenseKey;
	/** Short badge text, e.g. "CC-BY-NC-ND". */
	label: string;
	/** Plain-language terms (verbatim from FurTrack), for tooltips/detail view. */
	terms: string;
	/** May we display this photo publicly without asking the photographer first? */
	displayable: boolean;
	/** ND licenses: the image must be shown unmodified (no crop/recolor/overlay edits). */
	noEdits: boolean;
}

export const LICENSES: Record<LicenseKey, LicenseInfo> = {
	'cc-by': {
		key: 'cc-by',
		label: 'CC-BY',
		terms: 'Reposts, edits & commercial use OK. Must attribute photographer.',
		displayable: true,
		noEdits: false
	},
	'cc-by-nd': {
		key: 'cc-by-nd',
		label: 'CC-BY-ND',
		terms: 'Reposts & commercial use OK. Editing prohibited. Must attribute photographer.',
		displayable: true,
		noEdits: true
	},
	'cc-by-nc': {
		key: 'cc-by-nc',
		label: 'CC-BY-NC',
		terms: 'Reposts & edits OK. Commercial use prohibited. Must attribute photographer.',
		displayable: true,
		noEdits: false
	},
	'cc-by-nc-nd': {
		key: 'cc-by-nc-nd',
		label: 'CC-BY-NC-ND',
		terms: 'Reposts OK. Edits & commercial use prohibited. Must attribute photographer.',
		displayable: true,
		noEdits: true
	},
	'public-domain': {
		key: 'public-domain',
		label: 'Public Domain',
		terms: 'All use OK. No requirements, no liability, no takebacks.',
		displayable: true,
		noEdits: false
	},
	'photographer-discretion': {
		key: 'photographer-discretion',
		label: "Photographer's discretion",
		terms: "No copyright specified, check with photographer for permissions on using/reposting photo.",
		displayable: false,
		noEdits: true
	},
	'photographer-license': {
		key: 'photographer-license',
		label: "Photographer's license",
		terms: 'Released by photographer under a license with specific conditions. See source for license terms.',
		displayable: false,
		noEdits: true
	},
	'all-rights-reserved': {
		key: 'all-rights-reserved',
		label: '© All Rights Reserved',
		terms: 'Photographer does not allow reposts or usage except with explicit permission/license.',
		displayable: false,
		noEdits: true
	},
	unknown: {
		key: 'unknown',
		label: 'Unknown',
		terms: 'Copyright could not be determined — hidden until confirmed.',
		displayable: false,
		noEdits: true
	}
};

// Map FurTrack's raw `postCopyright` value to a LicenseKey.
//
// NOTE: the exact on-the-wire encoding (string label vs numeric index) is not yet
// confirmed against the live API — see the furtrack-api notes. This resolver accepts
// the human-readable label forms and common slug forms; ANYTHING it can't positively
// identify falls through to `unknown`, which is NOT displayable. That fail-closed
// default is intentional: we never show a photo whose license we can't confirm.
const LABEL_ALIASES: Record<string, LicenseKey> = {
	'cc-by': 'cc-by',
	'cc by': 'cc-by',
	'cc-by-nd': 'cc-by-nd',
	'cc-by-nc': 'cc-by-nc',
	'cc-by-nc-nd': 'cc-by-nc-nd',
	'public domain': 'public-domain',
	'public-domain': 'public-domain',
	"photographer's discretion": 'photographer-discretion',
	'photographer discretion': 'photographer-discretion',
	"photographer's license": 'photographer-license',
	'photographer license': 'photographer-license',
	'all rights reserved': 'all-rights-reserved',
	'© all rights reserved': 'all-rights-reserved'
};

// FurTrack stores `postCopyright` as an integer enum (NOT the dropdown's display
// order). Only codes we've positively confirmed against live posts are listed;
// every other code falls through to `unknown` (not displayable). That fail-closed
// gap is deliberate — guessing an unconfirmed code risks publishing a photo whose
// license doesn't actually permit it. Confirmed 2026-05 against live posts:
//   1 = Photographer's discretion   2 = CC-BY-NC-ND   3 = CC-BY-NC
//   4 = CC-BY-ND   5 = CC-BY   6 = Photographer's license   10 = Public Domain
// Still UNCONFIRMED (stay `unknown` until verified against a live post):
// All Rights Reserved (and codes 7-9).
const COPYRIGHT_CODES: Record<number, LicenseKey> = {
	1: 'photographer-discretion',
	2: 'cc-by-nc-nd',
	3: 'cc-by-nc',
	4: 'cc-by-nd',
	5: 'cc-by',
	6: 'photographer-license',
	10: 'public-domain'
};

export function resolveLicense(raw: string | number | null | undefined): LicenseInfo {
	// Integer enum, or a numeric string of one.
	if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw.trim()))) {
		const key = COPYRIGHT_CODES[Number(raw)];
		return key ? LICENSES[key] : LICENSES.unknown;
	}
	// Defensive: also accept a textual label, should the API ever return one.
	if (typeof raw === 'string') {
		const key = LABEL_ALIASES[raw.trim().toLowerCase()];
		if (key) return LICENSES[key];
	}
	return LICENSES.unknown;
}
