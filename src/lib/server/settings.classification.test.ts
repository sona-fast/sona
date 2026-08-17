import { describe, it, expect } from 'vitest';
import {
	DEFAULTS,
	PUBLIC_SETTINGS_KEYS,
	SERVER_ONLY_SETTINGS_KEYS,
	toPublicSettings,
	type SiteSettings
} from './settings';

// DEFAULTS is typed `SiteSettings`, so the compiler requires every key of the
// interface to appear in its literal — its runtime keys ARE the interface.
const ALL_KEYS = Object.keys(DEFAULTS) as (keyof SiteSettings)[];

describe('settings classification', () => {
	// The point of the allowlist: adding a field to SiteSettings must be a
	// deliberate publish-or-withhold decision, not a default-publish.
	it('classifies every SiteSettings key as public or server-only', () => {
		const classified = new Set<string>([...PUBLIC_SETTINGS_KEYS, ...SERVER_ONLY_SETTINGS_KEYS]);
		const unclassified = ALL_KEYS.filter((key) => !classified.has(key));

		expect(
			unclassified,
			'Add each key to PUBLIC_SETTINGS_KEYS (it then rides every public page’s client payload) or to SERVER_ONLY_SETTINGS_KEYS in src/lib/server/settings.ts'
		).toEqual([]);
	});

	it('never lists a key as both public and server-only', () => {
		const publicKeys = new Set<string>(PUBLIC_SETTINGS_KEYS);
		expect(SERVER_ONLY_SETTINGS_KEYS.filter((key) => publicKeys.has(key))).toEqual([]);
	});

	// A key removed from SiteSettings must not linger in either list, where it
	// would keep a since-deleted field looking classified.
	it('lists no key that SiteSettings does not have', () => {
		const all = new Set<string>(ALL_KEYS);
		const stale = [...PUBLIC_SETTINGS_KEYS, ...SERVER_ONLY_SETTINGS_KEYS].filter(
			(key) => !all.has(key)
		);
		expect(stale).toEqual([]);
	});

	// The emitted payload is the allowlist itself — no more, no less.
	it('emits exactly the public keys and withholds the server-only ones', () => {
		const pub = toPublicSettings(DEFAULTS);
		expect(Object.keys(pub).sort()).toEqual([...PUBLIC_SETTINGS_KEYS].sort());
		for (const key of SERVER_ONLY_SETTINGS_KEYS) {
			expect(pub).not.toHaveProperty(key);
		}
	});

	it('carries each public value through unchanged', () => {
		const settings: SiteSettings = { ...DEFAULTS, siteName: 'Example', aiPageText: 'Retired copy.' };
		const pub = toPublicSettings(settings) as Record<string, unknown>;
		for (const key of PUBLIC_SETTINGS_KEYS) {
			expect(pub[key]).toBe(settings[key]);
		}
		expect(JSON.stringify(pub)).not.toContain('Retired copy.');
	});
});
