import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Always-on guard for the committed VR fixture (e2e-textured.vrm): it's a
// build artifact of generate-vr-fixture.mjs, and nothing else in CI would
// notice it going missing, drifting from the size seed.sql declares, or being
// replaced by something that isn't a VRM-carrying GLB — the vr-render e2e
// would just fail with an opaque viewer error.
//
// Deliberately STRUCTURAL, not a byte-compare against regeneration: the
// fixture's embedded PNG is compressed with this Node's zlib, and the deflate
// stream is not pinned across zlib implementations (zlib-ng emits different,
// equally valid bytes) — a byte-compare here would break on a Node upgrade
// with the committed file still perfectly good. Every check below is
// deterministic over the committed bytes alone. The exact byte-compare lives
// in `generate-vr-fixture.mjs --check` for humans regenerating the fixture.
//
// (Runs under vitest via the tests/e2e/fixtures include glob in
// vitest.config.ts — scoped to *.test.ts so the playwright *.spec.ts files
// next door stay out of the unit suite.)

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'e2e-textured.vrm');
const seedSqlPath = path.join(here, 'seed.sql');

describe('e2e-textured.vrm committed fixture', () => {
	it('exists (regenerate with: node tests/e2e/fixtures/generate-vr-fixture.mjs)', () => {
		expect(existsSync(fixturePath)).toBe(true);
	});

	it('matches the model_size_bytes seeded for e2e-textured in seed.sql', () => {
		// Parse the literal out of the INSERT so a regenerated fixture whose size
		// changed can't silently disagree with what the loading-progress UI is
		// told. Matches: (4, 'e2e-textured', '<name>', <char>, '<url>', 'vrm', <size>,
		const seedSql = readFileSync(seedSqlPath, 'utf8');
		const match = seedSql.match(/'e2e-textured',[^(]*?'vrm',\s*(\d+),/);
		expect(match, "seed.sql declares a model_size_bytes for slug 'e2e-textured'").not.toBeNull();
		expect(readFileSync(fixturePath).length).toBe(Number(match![1]));
	});

	it('is a structurally sane GLB carrying a VRMC_vrm extension', () => {
		const glb = readFileSync(fixturePath);

		// GLB header: magic 'glTF', container version 2, declared length = actual.
		expect(glb.readUInt32LE(0).toString(16)).toBe('46546c67');
		expect(glb.readUInt32LE(4)).toBe(2);
		expect(glb.readUInt32LE(8)).toBe(glb.length);

		// Chunk 0: JSON, its declared length consistent with the file size.
		const jsonLen = glb.readUInt32LE(12);
		expect(glb.readUInt32LE(16).toString(16)).toBe('4e4f534a'); // 'JSON'
		expect(20 + jsonLen).toBeLessThan(glb.length);

		// Chunk 1: BIN, and the two chunks tile the file exactly.
		const binLen = glb.readUInt32LE(20 + jsonLen);
		expect(glb.readUInt32LE(20 + jsonLen + 4).toString(16)).toBe('4e4942'); // 'BIN\0'
		expect(20 + jsonLen + 8 + binLen).toBe(glb.length);

		// The JSON chunk is what the viewer's loader chain actually gates on:
		// VRMC_vrm present with the 15 humanoid bones and the one licenseUrl
		// three-vrm accepts (anything else throws before userData.vrm is set).
		const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
		expect(json.extensionsUsed).toContain('VRMC_vrm');
		expect(json.extensions.VRMC_vrm.specVersion).toBe('1.0');
		expect(json.extensions.VRMC_vrm.meta.licenseUrl).toBe('https://vrm.dev/licenses/1.0/');
		expect(Object.keys(json.extensions.VRMC_vrm.humanoid.humanBones)).toHaveLength(15);

		// The embedded texture the vr-render spec's red-pixel assertion rides on:
		// a baseColorTexture whose image bufferView starts with the PNG signature.
		const material = json.materials[0];
		expect(material.pbrMetallicRoughness.baseColorTexture).toBeDefined();
		const image = json.images[0];
		const view = json.bufferViews[image.bufferView];
		const binStart = 20 + jsonLen + 8;
		const pngHead = glb.subarray(binStart + view.byteOffset, binStart + view.byteOffset + 4);
		expect(pngHead.toString('hex')).toBe('89504e47');

		// The glTF buffer must fit inside the (4-byte-padded) BIN chunk.
		expect(json.buffers[0].byteLength).toBeLessThanOrEqual(binLen);
	});
});
