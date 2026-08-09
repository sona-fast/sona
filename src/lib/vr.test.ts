import { describe, it, expect } from 'vitest';
import {
	deriveModelKey,
	deriveModelPath,
	externalSiteName,
	isPermissiveVrLicense,
	modelExt,
	modelFormatLabel,
	viewerSupports
} from './vr';

const ORIGIN = 'https://site.example';
const CDN = 'https://cdn.example.com';

describe('isPermissiveVrLicense', () => {
	it('allows exactly personal-use and cc-by', () => {
		expect(isPermissiveVrLicense('personal-use')).toBe(true);
		expect(isPermissiveVrLicense('cc-by')).toBe(true);
	});

	it('refuses the restrictive licenses and the unset case', () => {
		expect(isPermissiveVrLicense('base-tos')).toBe(false);
		expect(isPermissiveVrLicense('all-rights-reserved')).toBe(false);
		expect(isPermissiveVrLicense(null)).toBe(false);
		expect(isPermissiveVrLicense(undefined)).toBe(false);
		expect(isPermissiveVrLicense('')).toBe(false);
	});
});

describe('deriveModelPath / deriveModelKey', () => {
	it('maps a custom-domain (r2PublicUrl) model URL to /img/<key>', () => {
		expect(
			deriveModelPath(`${CDN}/models/abc.vrm`, { origin: ORIGIN, r2PublicUrl: CDN })
		).toBe('/img/models/abc.vrm');
	});

	it('keeps the key of an /img-pathed URL instead of nesting it (deleteOrphans rule)', () => {
		// A URL stored while serving via the /img route already carries the key
		// after '/img/' — it must not become /img/img/<key>.
		expect(
			deriveModelPath(`${ORIGIN}/img/models/abc.vrm`, { origin: ORIGIN, r2PublicUrl: '' })
		).toBe('/img/models/abc.vrm');
	});

	it('maps a root-relative /img URL', () => {
		expect(deriveModelPath('/img/models/abc.vrm', { origin: ORIGIN })).toBe('/img/models/abc.vrm');
	});

	it('returns null for a foreign host — the viewer gets no path to fetch', () => {
		// connect-src 'self': a cross-origin model URL can never be fetched by the
		// viewer, and the download route must not stream a key a foreign URL spells.
		expect(
			deriveModelPath('https://evil.example/img/models/abc.vrm', {
				origin: ORIGIN,
				r2PublicUrl: CDN
			})
		).toBeNull();
	});

	it('does not treat a foreign /img path as owned when no r2PublicUrl is set', () => {
		expect(
			deriveModelPath('https://evil.example/img/models/abc.vrm', { origin: ORIGIN, r2PublicUrl: '' })
		).toBeNull();
	});

	it('returns null for null/empty/unparseable/non-http URLs', () => {
		expect(deriveModelPath(null, { origin: ORIGIN })).toBeNull();
		expect(deriveModelPath('', { origin: ORIGIN })).toBeNull();
		expect(deriveModelPath('ftp://cdn.example.com/x.vrm', { origin: ORIGIN })).toBeNull();
		expect(deriveModelPath('data:text/plain,hi', { origin: ORIGIN })).toBeNull();
	});

	it('normalizes dot segments so ".." never reaches a key', () => {
		expect(deriveModelKey('/img/a/../models/abc.vrm', { origin: ORIGIN })).toBe('models/abc.vrm');
	});

	it('derives a bare key from a same-origin URL without the /img prefix', () => {
		// Mirrors deleteOrphans: pathname minus its leading slash.
		expect(deriveModelKey(`${CDN}/models/abc.vrm`, { origin: ORIGIN, r2PublicUrl: CDN })).toBe(
			'models/abc.vrm'
		);
	});

	it('returns null for an origin-only URL (empty key)', () => {
		expect(deriveModelPath(`${CDN}/`, { origin: ORIGIN, r2PublicUrl: CDN })).toBeNull();
	});
});

describe('modelExt / modelFormatLabel / viewerSupports', () => {
	it('maps vrm and vrm0 to .vrm, fbx to .fbx', () => {
		expect(modelExt('vrm')).toBe('vrm');
		expect(modelExt('vrm0')).toBe('vrm');
		expect(modelExt('fbx')).toBe('fbx');
		expect(modelExt(null)).toBe('vrm');
	});

	it('labels formats for the "3D · VRM" badge', () => {
		expect(modelFormatLabel('vrm')).toBe('VRM');
		expect(modelFormatLabel('vrm0')).toBe('VRM');
		expect(modelFormatLabel('fbx')).toBe('FBX');
	});

	it('offers the in-page viewer only for VRM formats', () => {
		expect(viewerSupports('vrm')).toBe(true);
		expect(viewerSupports('vrm0')).toBe(true);
		expect(viewerSupports('fbx')).toBe(false);
		expect(viewerSupports(null)).toBe(false);
	});
});

describe('externalSiteName', () => {
	it('names known destinations, including subdomains', () => {
		expect(externalSiteName('https://hub.vroid.com/characters/123')).toBe('VRoid Hub');
		expect(externalSiteName('https://someone.booth.pm/items/456')).toBe('BOOTH');
		expect(externalSiteName('https://www.gumroad.com/l/x')).toBe('Gumroad');
	});

	it('falls back to the bare hostname for unknown destinations', () => {
		expect(externalSiteName('https://example.shop/avatar')).toBe('example.shop');
	});

	it('returns null for missing or unparseable URLs', () => {
		expect(externalSiteName(null)).toBeNull();
		expect(externalSiteName('not a url')).toBeNull();
	});
});
