import { describe, it, expect, vi } from 'vitest';
import { earlyAccessLabel } from './early-access-label';

// The settings page's supporter status line renders each early-access flag
// through this resolver (SONA-124 item: never the raw slug). The registry is
// empty since vr-avatars retired (SONA-157), so no real label message exists —
// the messages module is mocked with a synthetic 'probe' label so both the
// positive-resolution path (message found, locale option forwarded) and the
// slug fallback (unknown key → undefined) stay covered. The mock returns a
// constant; toHaveBeenCalledWith is what proves the locale option forwards.
const probeLabel = vi.hoisted(() => vi.fn(() => 'Probe label'));
// The fallback test's key must be PRESENT with an undefined value — vitest's
// mock module throws on access to exports it doesn't know about, which would
// mask the fallback branch instead of exercising it.
vi.mock('$lib/paraglide/messages', () => ({
	early_access_label_probe: probeLabel,
	early_access_label_flag_without_message: undefined
}));

describe('earlyAccessLabel', () => {
	it('resolves the by-convention message and forwards the locale option', () => {
		expect(earlyAccessLabel('probe', { locale: 'ja' })).toBe('Probe label');
		expect(probeLabel).toHaveBeenCalledWith({}, { locale: 'ja' });
	});

	it('falls back to the flag slug when no label message exists', () => {
		expect(earlyAccessLabel('flag-without-message', { locale: 'en' })).toBe('flag-without-message');
	});

	it('matches the real compiled messages-module shape the resolver relies on', async () => {
		// The mock above keeps these tests hermetic, so this one pins the seam it
		// hides: the resolver reaches messages by computed name and calls
		// fn(inputs, { locale }). If a paraglide upgrade changes the compiled
		// module to a proxy, lazy, or default-export shape, the computed lookup
		// stops returning functions and every label silently falls back to the
		// raw slug — this assertion fails first. admin_vr_back is an ordinary
		// long-lived message; any stable id works.
		const real = await vi.importActual<Record<string, unknown>>('$lib/paraglide/messages');
		const fn = real['admin_vr_back'];
		expect(typeof fn).toBe('function');
		const label = (fn as (i: Record<string, never>, o?: { locale?: string }) => string)({}, { locale: 'ja' });
		expect(typeof label).toBe('string');
		expect(label.length).toBeGreaterThan(0);
	});
});
