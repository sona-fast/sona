import { describe, it, expect, vi } from 'vitest';
import { earlyAccessLabel } from './early-access-label';

// The settings page's supporter status line renders each early-access flag
// through this resolver (SONA-124 item: never the raw slug). The registry is
// empty since vr-avatars retired (SONA-157), so no real label message exists —
// the messages module is mocked with a synthetic 'probe' label so both the
// positive-resolution path (message found, locale option forwarded) and the
// slug fallback (unknown key → undefined) stay covered.
const probeLabel = vi.hoisted(() =>
	vi.fn((_inputs?: Record<string, never>, options?: { locale?: string }) =>
		options?.locale === 'ja' ? 'プローブ' : 'Probe'
	)
);
// The fallback test's key must be PRESENT with an undefined value — vitest's
// mock module throws on access to exports it doesn't know about, which would
// mask the fallback branch instead of exercising it.
vi.mock('$lib/paraglide/messages', () => ({
	early_access_label_probe: probeLabel,
	early_access_label_flag_without_message: undefined
}));

describe('earlyAccessLabel', () => {
	it('resolves the by-convention message and forwards the locale option', () => {
		expect(earlyAccessLabel('probe', { locale: 'ja' })).toBe('プローブ');
		expect(probeLabel).toHaveBeenCalledWith({}, { locale: 'ja' });
	});

	it('falls back to the flag slug when no label message exists', () => {
		expect(earlyAccessLabel('flag-without-message', { locale: 'en' })).toBe('flag-without-message');
	});
});
