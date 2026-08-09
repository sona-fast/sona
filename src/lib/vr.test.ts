import { describe, it, expect } from 'vitest';
import {
	MAX_VR_MODEL_BYTES,
	externalSiteName,
	formatBytes,
	isPermissiveVrLicense,
	licenseLabel,
	creditRoleLabel,
	modelExt,
	modelFileError,
	modelFormatDetailLabel,
	modelFormatLabel,
	modelKeyFromUrl,
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

describe('modelKeyFromUrl (base-agnostic deleteOrphans rule)', () => {
	it('derives a bare key from a custom-domain (r2PublicUrl-era) model URL', () => {
		// Mirrors deleteOrphans: pathname minus its leading slash.
		expect(modelKeyFromUrl(`${CDN}/models/abc.vrm`, ORIGIN)).toBe('models/abc.vrm');
	});

	it('keeps the key of an /img-pathed URL instead of nesting it', () => {
		// A URL stored while serving via the /img route already carries the key
		// after '/img/' — it must not become img/<key>.
		expect(modelKeyFromUrl(`${ORIGIN}/img/models/abc.vrm`, ORIGIN)).toBe('models/abc.vrm');
	});

	it('maps a root-relative /img URL', () => {
		expect(modelKeyFromUrl('/img/models/abc.vrm', ORIGIN)).toBe('models/abc.vrm');
	});

	it('is base-agnostic: a URL under a DIFFERENT (e.g. former r2PublicUrl) host still yields its key', () => {
		// The r2PublicUrl-change case: stored URLs keep the base active at upload
		// time. Whether the key actually serves is the bucket get()'s decision —
		// a key we never stored just misses (see resolveModelBytes).
		expect(modelKeyFromUrl('https://old-cdn.example/models/abc.vrm', ORIGIN)).toBe(
			'models/abc.vrm'
		);
	});

	it('returns null for null/empty/unparseable/non-http URLs', () => {
		expect(modelKeyFromUrl(null, ORIGIN)).toBeNull();
		expect(modelKeyFromUrl('', ORIGIN)).toBeNull();
		expect(modelKeyFromUrl('ftp://cdn.example.com/x.vrm', ORIGIN)).toBeNull();
		expect(modelKeyFromUrl('data:text/plain,hi', ORIGIN)).toBeNull();
	});

	it('normalizes dot segments so ".." never reaches a key', () => {
		expect(modelKeyFromUrl('/img/a/../models/abc.vrm', ORIGIN)).toBe('models/abc.vrm');
	});

	it('returns null for an origin-only URL (empty key)', () => {
		expect(modelKeyFromUrl(`${CDN}/`, ORIGIN)).toBeNull();
	});
});

describe('modelFileError (client mirror of the upload guards)', () => {
	it('accepts .vrm and .fbx, case-insensitively', () => {
		expect(modelFileError({ name: 'taro.vrm', size: 1000 })).toBeNull();
		expect(modelFileError({ name: 'TARO.FBX', size: 1000 })).toBeNull();
	});

	it('rejects other extensions and extensionless names', () => {
		expect(modelFileError({ name: 'taro.glb', size: 1000 })).toBe('bad-type');
		expect(modelFileError({ name: 'taro', size: 1000 })).toBe('bad-type');
		expect(modelFileError({ name: '.vrm', size: 1000 })).toBe('bad-type');
	});

	it('rejects files over MAX_VR_MODEL_BYTES', () => {
		expect(modelFileError({ name: 'taro.vrm', size: MAX_VR_MODEL_BYTES })).toBeNull();
		expect(modelFileError({ name: 'taro.vrm', size: MAX_VR_MODEL_BYTES + 1 })).toBe('too-large');
	});
});

describe('formatBytes', () => {
	it('steps through B / KB / MB / GB', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
		expect(formatBytes(10 * 1024 * 1024 * 1024)).toBe('10.0 GB');
	});
});

describe('label helpers shared by public pages and admin', () => {
	it('labels licenses and returns null for none/unknown', () => {
		expect(licenseLabel('personal-use')).toBe('Personal use');
		expect(licenseLabel('cc-by')).toBe('CC BY');
		expect(licenseLabel(null)).toBeNull();
		expect(licenseLabel('made-up')).toBeNull();
	});

	it("labels credit roles, with role='other' named by its roleLabel", () => {
		expect(creditRoleLabel('base')).toBe('Base model');
		expect(creditRoleLabel('other', 'Blendshapes')).toBe('Blendshapes');
		// A row that slipped through without one degrades to the generic label.
		expect(creditRoleLabel('other', null)).toBe('Other');
	});

	it('details VRM versions for the admin table only', () => {
		expect(modelFormatDetailLabel('vrm')).toBe('VRM 1.0');
		expect(modelFormatDetailLabel('vrm0')).toBe('VRM 0.x');
		expect(modelFormatDetailLabel('fbx')).toBe('FBX');
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
