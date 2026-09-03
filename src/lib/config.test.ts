import { describe, it, expect, vi } from 'vitest';
import { GALLERY_ACCEPT, STICKER_ACCEPT, VR_MEDIA_ACCEPT } from './config';
import { ALLOWED_IMAGE_TYPES, isAllowedImageType } from './server/storage';

// A type only the accept string has uploads a file /api/upload refuses with a
// 415; a type only the server has is one the admin can't pick at all.
describe('GALLERY_ACCEPT', () => {
	const types = GALLERY_ACCEPT.split(',');

	it('offers only types the server stores', () => {
		for (const t of types) expect(isAllowedImageType(t)).toBe(true);
	});

	it('offers every type the server stores', () => {
		expect(new Set(types)).toEqual(ALLOWED_IMAGE_TYPES);
	});
});

// Same pin for the VR form's picker, which adds the one video type the showcase
// renders on top of the gallery's images.
describe('VR_MEDIA_ACCEPT', () => {
	const types = VR_MEDIA_ACCEPT.split(',');

	it('offers exactly the server image types, plus video/webm', () => {
		expect(new Set(types.filter((t) => t.startsWith('image/')))).toEqual(ALLOWED_IMAGE_TYPES);
		expect(types.filter((t) => !t.startsWith('image/'))).toEqual(['video/webm']);
	});
});

// Stickers deliberately offer fewer formats than the gallery, but never one the
// server refuses — that would upload a file just to collect a 415.
describe('STICKER_ACCEPT', () => {
	it('offers only types the server stores', () => {
		for (const t of STICKER_ACCEPT.split(',')) expect(isAllowedImageType(t)).toBe(true);
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
