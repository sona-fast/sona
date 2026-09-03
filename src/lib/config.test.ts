import { describe, it, expect, vi } from 'vitest';
import { GALLERY_ACCEPT } from './config';
import { ALLOWED_IMAGE_TYPES, isAllowedImageType } from './server/storage';

// The picker's accept string and the server's allowlist have to say the same
// thing: a type only the string has uploads a file /api/upload will refuse with
// a 415, and a type only the server has is one the admin can't pick at all.
describe('GALLERY_ACCEPT', () => {
	const types = GALLERY_ACCEPT.split(',');

	it('offers only types the server stores', () => {
		for (const t of types) expect(isAllowedImageType(t)).toBe(true);
	});

	it('offers every type the server stores', () => {
		expect(new Set(types)).toEqual(ALLOWED_IMAGE_TYPES);
	});
});

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
