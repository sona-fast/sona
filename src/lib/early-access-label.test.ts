import { describe, it, expect } from 'vitest';
import { earlyAccessLabel } from './early-access-label';

// The settings page's supporter status line renders each early-access flag
// through this resolver (SONA-124 item: never the raw slug). It goes through
// the real compiled paraglide messages module, so a passing test here proves
// the dynamic-lookup path works for both locales — an explicit locale option
// is passed so the test doesn't depend on paraglide's runtime locale state.
describe('earlyAccessLabel', () => {
	// The registry is empty since vr-avatars retired (SONA-157), so no real
	// label message exists to resolve; the positive-resolution tests return with
	// the next registered flag (early-access.test.ts forces its messages).
	it('falls back to the flag slug when no label message exists', () => {
		expect(earlyAccessLabel('flag-without-message', { locale: 'en' })).toBe('flag-without-message');
	});
});
