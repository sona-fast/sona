import { describe, it, expect, vi } from 'vitest';

describe('SESSION_COOKIE', () => {
	it('uses the __Host- prefix in production', async () => {
		// The vitest stub for `$app/environment` sets dev=false (prod). The
		// __Host- prefix is what makes the browser enforce Secure + host-only
		// (no Domain), so a subdomain can never receive another host's session.
		const { SESSION_COOKIE } = await import('./config');
		expect(SESSION_COOKIE).toBe('__Host-sona_admin_session');
		expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
	});

	it('drops the prefix in dev (no Secure over plain-HTTP localhost)', async () => {
		// __Host- requires Secure; dev serves plain HTTP, so the browser would
		// reject a prefixed cookie and lock the admin out. Bare name in dev.
		vi.resetModules();
		vi.doMock('$app/environment', () => ({
			dev: true,
			browser: false,
			building: false,
			version: 'test'
		}));
		const { SESSION_COOKIE } = await import('./config');
		expect(SESSION_COOKIE).toBe('sona_admin_session');
		vi.doUnmock('$app/environment');
		vi.resetModules();
	});
});
