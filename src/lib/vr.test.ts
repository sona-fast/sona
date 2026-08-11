import { describe, it, expect } from 'vitest';
import {
	MAX_VR_MODEL_BYTES,
	externalSiteName,
	formatBytes,
	frameHumanoid,
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

describe('frameHumanoid (SONA-165)', () => {
	// The e2e fixture's proportions: hips at y 0.9, head at 1.6, arms split
	// laterally — a plausible stand-in for a real upload.
	const upright = {
		hips: { x: 0, y: 0.9, z: 0 },
		head: { x: 0, y: 1.6, z: 0 },
		leftUpperArm: { x: 0.15, y: 1.35, z: 0 },
		rightUpperArm: { x: -0.15, y: 1.35, z: 0 },
		aspect: 4 / 3,
		fovDeg: 30
	};

	it('pivots between the hips and head bones', () => {
		const framing = frameHumanoid(upright)!;
		expect(framing.target).toEqual({ x: 0, y: 1.25, z: 0 });
	});

	it('derives distance from the head-to-hips span (2.2 spans of half-height at this fov)', () => {
		const framing = frameHumanoid(upright)!;
		const span = 0.7;
		const expected = (2.2 * span) / Math.tan((30 * Math.PI) / 360);
		expect(framing.position.z).toBeCloseTo(expected, 5);
		// Doubling the skeleton doubles the distance — nothing else feeds it.
		const doubled = frameHumanoid({
			...upright,
			hips: { x: 0, y: 1.8, z: 0 },
			head: { x: 0, y: 3.2, z: 0 }
		})!;
		expect(doubled.position.z - doubled.target.z).toBeCloseTo(
			2 * (framing.position.z - framing.target.z),
			5
		);
	});

	it('keeps the camera level with the pivot', () => {
		const framing = frameHumanoid(upright)!;
		expect(framing.position.y).toBe(framing.target.y);
	});

	it('orients from the model forward axis, not a world constant', () => {
		// Same skeleton yawed 90°: facing +X (left arm swings to -Z).
		const facingX = frameHumanoid({
			...upright,
			leftUpperArm: { x: 0, y: 1.35, z: -0.15 },
			rightUpperArm: { x: 0, y: 1.35, z: 0.15 }
		})!;
		expect(facingX.position.x).toBeGreaterThan(1);
		expect(facingX.position.z).toBeCloseTo(0, 5);

		// Yawed 180° (a VRM 0.x-style flip): camera must follow to -Z, which is
		// exactly what a +Z world constant gets wrong.
		const facingBack = frameHumanoid({
			...upright,
			leftUpperArm: { x: -0.15, y: 1.35, z: 0 },
			rightUpperArm: { x: 0.15, y: 1.35, z: 0 }
		})!;
		expect(facingBack.position.z).toBeLessThan(-1);
	});

	it('stays level for a leaning model (forward is flattened to the horizon)', () => {
		const leaning = frameHumanoid({
			...upright,
			head: { x: 0, y: 1.55, z: 0.25 }
		})!;
		expect(leaning.position.y).toBe(leaning.target.y);
	});

	it('falls back to +Z forward when the arm bones are missing or degenerate', () => {
		const armless = frameHumanoid({
			...upright,
			leftUpperArm: null,
			rightUpperArm: null
		})!;
		expect(armless.position.z).toBeGreaterThan(0);
		expect(armless.position.x).toBeCloseTo(0, 5);
		const collapsed = frameHumanoid({
			...upright,
			leftUpperArm: { x: 0, y: 1.35, z: 0 },
			rightUpperArm: { x: 0, y: 1.35, z: 0 }
		})!;
		expect(collapsed.position.z).toBeGreaterThan(0);
	});

	it('backs the camera up for narrow viewports (arm span must fit the width)', () => {
		const landscape = frameHumanoid(upright)!;
		const portrait = frameHumanoid({ ...upright, aspect: 0.5 })!;
		expect(portrait.position.z - portrait.target.z).toBeGreaterThan(
			landscape.position.z - landscape.target.z
		);
	});

	it('caps the distance inside the viewer camera far plane', () => {
		const giant = frameHumanoid({
			...upright,
			hips: { x: 0, y: 9, z: 0 },
			head: { x: 0, y: 16, z: 0 }
		})!;
		expect(giant.position.z - giant.target.z).toBe(40);
	});

	it('returns null for a degenerate skeleton (caller falls back to the bounding box)', () => {
		expect(frameHumanoid({ ...upright, head: { ...upright.hips } })).toBeNull();
		expect(frameHumanoid({ ...upright, head: { x: 0, y: NaN, z: 0 } })).toBeNull();
	});
});
