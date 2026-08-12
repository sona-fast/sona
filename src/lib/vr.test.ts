import { describe, it, expect } from 'vitest';
import {
	MAX_VR_MODEL_BYTES,
	VR_FRAME_DISTANCE_CAP,
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
	namePlaceholderCharacter,
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

describe('namePlaceholderCharacter', () => {
	// Name-ordered, as both VR loaders return them: the friend's featured sona
	// sorts first, the site's own character second.
	const characters = [
		{ id: 1, name: 'Nettle', isOwner: false },
		{ id: 2, name: 'Pike', isOwner: true }
	];

	it('uses the character selected in the form', () => {
		expect(namePlaceholderCharacter(characters, '1')).toBe('Nettle');
	});

	it("falls back to the site's own character, not the alphabetically first", () => {
		expect(namePlaceholderCharacter(characters, '')).toBe('Pike');
		expect(namePlaceholderCharacter(characters, '99')).toBe('Pike');
	});

	it('falls back to the first character when no character is flagged as the owner', () => {
		const noOwner = characters.map((c) => ({ ...c, isOwner: false }));
		expect(namePlaceholderCharacter(noOwner, '')).toBe('Nettle');
	});

	it('falls back to the translated stand-in on a site with no characters', () => {
		// The stand-in comes from the message catalogue (en under test), never a
		// hardcoded English literal in vr.ts.
		expect(namePlaceholderCharacter([], '')).toBe('your sona');
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

	it('pivots a quarter of the way up from the hips toward the head', () => {
		const framing = frameHumanoid(upright)!;
		// hips.y 0.9 + 0.25 × span 0.7 = 1.075 — low enough that the frame's
		// symmetric halves don't mirror the pivot-to-floor drop as headroom.
		expect(framing.target).toEqual({ x: 0, y: 1.075, z: 0 });
	});

	it('derives distance from the head-to-hips span (1.8 spans of half-height at this fov)', () => {
		const framing = frameHumanoid(upright)!;
		const span = 0.7;
		const expected = (1.8 * span) / Math.tan((30 * Math.PI) / 360);
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

	it('composes the canonical skeleton: ≥70% body fill, ≤18% headroom, ≥4% feet margin', () => {
		// Anchored to the function's OUTPUT: the world-space frame half-height
		// at the pivot plane is (camera distance) × tan(fov/2), with the
		// distance recomputed from the returned camera/target pair. The
		// acceptance numbers come from the worked arithmetic in the
		// frameHumanoid doc comment.
		const framing = frameHumanoid(upright)!;
		const dist = Math.hypot(
			framing.position.x - framing.target.x,
			framing.position.y - framing.target.y,
			framing.position.z - framing.target.z
		);
		const halfH = dist * Math.tan((30 * Math.PI) / 360);
		const frameHeight = 2 * halfH;
		const frameTop = framing.target.y + halfH;
		const frameBottom = framing.target.y - halfH;
		const crown = 1.6 / 0.85; // head bone ≈ 0.85 × height → crown ≈ 1.88
		const feet = 0;
		expect((crown - feet) / frameHeight).toBeGreaterThanOrEqual(0.7);
		expect((frameTop - crown) / frameHeight).toBeLessThanOrEqual(0.18);
		expect((feet - frameBottom) / frameHeight).toBeGreaterThanOrEqual(0.04);
	});

	it('flattens forward to the horizon for a leaning model (full fitted distance stays horizontal)', () => {
		const leaning = frameHumanoid({
			...upright,
			head: { x: 0, y: 1.55, z: 0.25 }
		})!;
		// The fit formula runs on the ACTUAL 3D span; the flattened direction
		// then spends all of that distance horizontally. A regression that
		// normalizes the full 3D forward instead of flattening it would leave
		// only distance × (flat ∕ ‖forward‖) in the horizontal plane.
		const span = Math.hypot(0, 0.65, 0.25);
		const expected = (1.8 * span) / Math.tan((30 * Math.PI) / 360);
		expect(
			Math.hypot(leaning.position.x - leaning.target.x, leaning.position.z - leaning.target.z)
		).toBeCloseTo(expected, 5);
		expect(leaning.position.y).toBe(leaning.target.y);
	});

	it('returns null for a near-horizontal spine (quadruped rig) instead of framing from noise', () => {
		// A feral/quadruped rig: spine nearly along the ground, front-leg bones
		// split laterally. The anatomical forward points near-vertical, so its
		// horizontal part is numerical residue — the caller's bounding-box
		// branch must take over.
		expect(
			frameHumanoid({
				...upright,
				hips: { x: 0, y: 0.6, z: -0.4 },
				head: { x: 0, y: 0.7, z: 0.5 },
				leftUpperArm: { x: 0.1, y: 0.3, z: 0.5 },
				rightUpperArm: { x: -0.1, y: 0.3, z: 0.5 }
			})
		).toBeNull();
	});

	it('returns null for a lying-on-back rig (forward is pure vertical)', () => {
		expect(
			frameHumanoid({
				...upright,
				hips: { x: 0, y: 1, z: 0 },
				head: { x: 0, y: 1, z: 0.7 },
				leftUpperArm: { x: 0.15, y: 1, z: 0.35 },
				rightUpperArm: { x: -0.15, y: 1, z: 0.35 }
			})
		).toBeNull();
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
		// Near-coincident arms (1e-9 apart, noise on this 0.7 span): the
		// RELATIVE epsilon treats them as degenerate, +Z fallback again. The
		// arms are REVERSED, so trusting the noise would flip the camera to −Z.
		const nearCoincident = frameHumanoid({
			...upright,
			leftUpperArm: { x: -5e-10, y: 1.35, z: 0 },
			rightUpperArm: { x: 5e-10, y: 1.35, z: 0 }
		})!;
		expect(nearCoincident).not.toBeNull();
		expect(nearCoincident.position.z).toBeGreaterThan(0);
		expect(nearCoincident.position.x).toBeCloseTo(0, 5);
		// Same judgment must SCALE: on a 100× skeleton (span 70), reversed arms
		// 0.05 apart are still noise relative to the body. The relative epsilon
		// (1e-3 × span = 0.07) rejects them and keeps the +Z fallback; an
		// absolute 1e-3 would trust the noise and flip the camera to −Z.
		const scaledNoise = frameHumanoid({
			...upright,
			hips: { x: 0, y: 90, z: 0 },
			head: { x: 0, y: 160, z: 0 },
			leftUpperArm: { x: -0.025, y: 135, z: 0 },
			rightUpperArm: { x: 0.025, y: 135, z: 0 }
		})!;
		expect(scaledNoise).not.toBeNull();
		expect(scaledNoise.position.z).toBeGreaterThan(0);
	});

	it('portrait crops the arms instead of receding: ≥0.6-span half-width, ≥60% vertical fill', () => {
		// The width term is a FLOOR: the visible half-width never drops below
		// 0.6 × span (an arm crop just outside the shoulders) and the frame
		// never backs off to fit
		// the full arm span — the height fit governs on real phone aspects and
		// the body keeps filling the frame. Anchored to the output: half-width
		// = dist × tan(fov/2) × aspect. At 0.5 the height fit governs; at 0.3
		// the 0.6-span floor itself binds, so a drop in that constant fails the
		// half-width assertion.
		const tan = Math.tan((30 * Math.PI) / 360);
		const span = 0.7;
		const crown = 1.6 / 0.85;
		for (const aspect of [0.5, 0.3]) {
			const portrait = frameHumanoid({ ...upright, aspect })!;
			const dist = Math.hypot(
				portrait.position.x - portrait.target.x,
				portrait.position.y - portrait.target.y,
				portrait.position.z - portrait.target.z
			);
			expect(dist * tan * aspect).toBeGreaterThanOrEqual(0.6 * span * (1 - 1e-9));
			expect(crown / (2 * dist * tan)).toBeGreaterThanOrEqual(0.6);
		}
	});

	it('near-square keeps the full T-pose arm half-span (≈1.45 × span) in frame', () => {
		// At aspect 0.95 the height fit governs and the visible half-width,
		// dist × tan(fov/2) × aspect = 1.8 × 0.95 × span, still covers the
		// documented arm half-span of 1.45 × span (it fits whenever aspect ≥
		// ~0.81) — this pins the 1.8 height constant from the width side.
		const nearSquare = frameHumanoid({ ...upright, aspect: 0.95 })!;
		const dist = Math.hypot(
			nearSquare.position.x - nearSquare.target.x,
			nearSquare.position.y - nearSquare.target.y,
			nearSquare.position.z - nearSquare.target.z
		);
		const halfW = dist * Math.tan((30 * Math.PI) / 360) * 0.95;
		expect(halfW).toBeGreaterThanOrEqual(1.45 * 0.7);
	});

	it('caps the distance inside the viewer camera far plane', () => {
		const giant = frameHumanoid({
			...upright,
			hips: { x: 0, y: 9, z: 0 },
			head: { x: 0, y: 16, z: 0 }
		})!;
		expect(giant.position.z - giant.target.z).toBe(VR_FRAME_DISTANCE_CAP);
	});

	it('returns null for a degenerate skeleton (caller falls back to the bounding box)', () => {
		expect(frameHumanoid({ ...upright, head: { ...upright.hips } })).toBeNull();
		expect(frameHumanoid({ ...upright, head: { x: 0, y: NaN, z: 0 } })).toBeNull();
	});

	it('returns null for hostile viewport numbers instead of NaN framing', () => {
		expect(frameHumanoid({ ...upright, aspect: NaN })).toBeNull();
		expect(frameHumanoid({ ...upright, aspect: 0 })).toBeNull();
		expect(frameHumanoid({ ...upright, aspect: -1 })).toBeNull();
		expect(frameHumanoid({ ...upright, fovDeg: 0 })).toBeNull();
		expect(frameHumanoid({ ...upright, fovDeg: 180 })).toBeNull();
		expect(frameHumanoid({ ...upright, fovDeg: NaN })).toBeNull();
	});

	it('returns null when huge bone coordinates overflow the span (the span guard catches the Infinity)', () => {
		expect(
			frameHumanoid({
				...upright,
				hips: { x: -Number.MAX_VALUE, y: 0.9, z: 0 },
				head: { x: Number.MAX_VALUE, y: 1.6, z: 0 }
			})
		).toBeNull();
	});
});
