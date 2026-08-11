// Generates tests/e2e/fixtures/e2e-textured.vrm — the minimal REAL model the
// vr-render spec drives through the viewer's actual GLTFLoader + three-vrm
// path. The 47-byte text stub seed.ts writes for e2e-avatar can only satisfy
// the R2 head probe; parsing it always lands in the error banner, so no e2e
// ever proved a texture loads. This fixture closes that gap.
//
// Why a VRM and not a plain GLB: VrViewer.svelte hard-requires
// gltf.userData.vrm (`if (!vrm) throw new Error('not a VRM model')`), and
// three-vrm's VRMLoaderPlugin only sets that when the file carries a VRMC_vrm
// extension whose meta has an accepted licenseUrl AND whose humanoid maps all
// 15 required bones (hips…rightHand — VRMHumanoidLoaderPlugin throws on any
// missing one). So the minimum viable fixture is a VRM 1.0: one textured quad
// plus 15 empty bone nodes.
//
// Everything is built from first principles right here — glTF 2.0 JSON + BIN
// chunks, and the embedded PNG (zlib.deflateSync + hand-rolled CRC32) — so the
// binary's provenance is this script, not an opaque base64 blob. Output is
// deterministic for a given Node/zlib build; the generated .vrm is committed
// so CI never depends on regenerating it.
//
// Regenerate with: node tests/e2e/fixtures/generate-vr-fixture.mjs
// (then update model_size_bytes for e2e-textured in seed.sql if the size
// changed — it only drives the loading-progress display).
//
// Verify with: node tests/e2e/fixtures/generate-vr-fixture.mjs --check
// (regenerates in memory and byte-compares against the committed file). The
// byte-compare is for humans on a known-good Node: the PNG's deflate stream is
// whatever this Node's zlib emits, which is NOT pinned across zlib
// implementations (a Node that swaps in zlib-ng would produce a different but
// equally valid stream) — that's why CI guards the committed binary with the
// structural fixture-integrity.test.ts instead of regenerating it there.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

// ---------------------------------------------------------------------------
// PNG: 8x8 solid red-orange (230, 40, 20), RGB8. The color is the load-bearing
// part: the material's baseColorFactor stays default WHITE and both lights are
// white, so red-dominant rendered pixels can only come from this texture being
// decoded and sampled — an untextured fallback renders the quad white/gray.
// The spec asserts exactly that.
// ---------------------------------------------------------------------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes) {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

function buildPng(size, [r, g, b]) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB
	// compression 0, filter 0, interlace 0 (already zeroed)

	// Raw scanlines: filter byte 0 + size RGB pixels per row.
	const raw = Buffer.alloc(size * (1 + size * 3));
	for (let y = 0; y < size; y++) {
		const row = y * (1 + size * 3);
		for (let x = 0; x < size; x++) {
			raw[row + 1 + x * 3] = r;
			raw[row + 2 + x * 3] = g;
			raw[row + 3 + x * 3] = b;
		}
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', deflateSync(raw, { level: 9 })),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

const png = buildPng(8, [230, 40, 20]);

// ---------------------------------------------------------------------------
// Geometry: one vertical quad, 1m wide × 1.5m tall, centered at x=0 spanning
// y ∈ [0.25, 1.75] — roughly avatar-sized so VrViewer's bounding-box camera
// framing puts it squarely in view. doubleSided in the material so winding can
// never blank it.
// ---------------------------------------------------------------------------
const positions = new Float32Array([
	-0.5, 0.25, 0, 0.5, 0.25, 0, 0.5, 1.75, 0, -0.5, 1.75, 0
]);
const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

// BIN chunk: each bufferView 4-byte aligned (Float32/Uint16 data is already
// aligned by construction; the PNG goes last so its length can be odd).
const binParts = [
	Buffer.from(positions.buffer),
	Buffer.from(normals.buffer),
	Buffer.from(uvs.buffer),
	Buffer.from(indices.buffer),
	png
];
const bufferViews = [];
let binLength = 0;
for (const part of binParts) {
	bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: part.length });
	binLength += part.length;
}

// ---------------------------------------------------------------------------
// Humanoid: the 15 bones VRMHumanoidLoaderPlugin requires, as bare nodes in a
// plausible hips→spine→head / arms / legs hierarchy. Node 0 is the mesh; bones
// start at 1. Nothing is skinned to them — three-vrm only needs the nodes to
// exist and resolve.
// ---------------------------------------------------------------------------
const nodes = [{ name: 'body', mesh: 0 }];
const humanBones = {};
// [vrm bone name, parent node index or null (child of hips subtree root), translation]
const boneDefs = [
	['hips', null, [0, 0.9, 0]],
	['spine', 'hips', [0, 0.2, 0]],
	['head', 'spine', [0, 0.5, 0]],
	['leftUpperArm', 'spine', [0.2, 0.4, 0]],
	['leftLowerArm', 'leftUpperArm', [0.25, 0, 0]],
	['leftHand', 'leftLowerArm', [0.25, 0, 0]],
	['rightUpperArm', 'spine', [-0.2, 0.4, 0]],
	['rightLowerArm', 'rightUpperArm', [-0.25, 0, 0]],
	['rightHand', 'rightLowerArm', [-0.25, 0, 0]],
	['leftUpperLeg', 'hips', [0.1, -0.05, 0]],
	['leftLowerLeg', 'leftUpperLeg', [0, -0.4, 0]],
	['leftFoot', 'leftLowerLeg', [0, -0.45, 0]],
	['rightUpperLeg', 'hips', [-0.1, -0.05, 0]],
	['rightLowerLeg', 'rightUpperLeg', [0, -0.4, 0]],
	['rightFoot', 'rightLowerLeg', [0, -0.45, 0]]
];
const boneIndex = {};
for (const [bone, parent, translation] of boneDefs) {
	const index = nodes.length;
	nodes.push({ name: bone, translation });
	boneIndex[bone] = index;
	humanBones[bone] = { node: index };
	if (parent) {
		(nodes[boneIndex[parent]].children ??= []).push(index);
	}
}

const json = {
	asset: {
		version: '2.0',
		generator: 'sona tests/e2e/fixtures/generate-vr-fixture.mjs'
	},
	extensionsUsed: ['VRMC_vrm'],
	extensions: {
		VRMC_vrm: {
			specVersion: '1.0',
			meta: {
				name: 'Sona E2E Textured Fixture',
				version: '1.0.0',
				authors: ['sona e2e harness'],
				// The ONLY licenseUrl three-vrm accepts by default; anything else
				// makes VRMMetaLoaderPlugin throw and the viewer show its error state.
				licenseUrl: 'https://vrm.dev/licenses/1.0/',
				avatarPermission: 'onlyAuthor',
				allowExcessivelyViolentUsage: false,
				allowExcessivelySexualUsage: false,
				commercialUsage: 'personalNonProfit',
				allowPoliticalOrReligiousUsage: false,
				allowAntisocialOrHateUsage: false,
				creditNotation: 'required',
				allowRedistribution: false,
				modification: 'prohibited'
			},
			humanoid: { humanBones }
		}
	},
	scene: 0,
	scenes: [{ nodes: [0, boneIndex.hips] }],
	nodes,
	meshes: [
		{
			name: 'quad',
			primitives: [
				{
					attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
					indices: 3,
					material: 0
				}
			]
		}
	],
	materials: [
		{
			name: 'e2e-textured',
			// baseColorFactor deliberately left at its default (white): every drop
			// of red in the render must come from the texture.
			pbrMetallicRoughness: {
				baseColorTexture: { index: 0 },
				metallicFactor: 0,
				roughnessFactor: 1
			},
			doubleSided: true
		}
	],
	textures: [{ sampler: 0, source: 0 }],
	images: [{ name: 'e2e-red', mimeType: 'image/png', bufferView: 4 }],
	samplers: [{ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }],
	buffers: [{ byteLength: binLength }],
	bufferViews,
	accessors: [
		{
			bufferView: 0,
			componentType: 5126,
			count: 4,
			type: 'VEC3',
			min: [-0.5, 0.25, 0],
			max: [0.5, 1.75, 0]
		},
		{ bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
		{ bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
		{ bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' }
	]
};

// ---------------------------------------------------------------------------
// GLB container: 12-byte header + JSON chunk (space-padded to 4) + BIN chunk
// (zero-padded to 4).
// ---------------------------------------------------------------------------
function pad4(buffer, fill) {
	const rem = buffer.length % 4;
	return rem === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - rem, fill)]);
}

const jsonChunk = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
const binChunk = pad4(Buffer.concat(binParts), 0x00);

const glb = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binChunk.length);
let o = 0;
o = glb.writeUInt32LE(0x46546c67, o); // 'glTF'
o = glb.writeUInt32LE(2, o);
o = glb.writeUInt32LE(glb.length, o);
o = glb.writeUInt32LE(jsonChunk.length, o);
o = glb.writeUInt32LE(0x4e4f534a, o); // 'JSON'
o += jsonChunk.copy(glb, o);
o = glb.writeUInt32LE(binChunk.length, o);
o = glb.writeUInt32LE(0x004e4942, o); // 'BIN\0'
binChunk.copy(glb, o);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e-textured.vrm');
if (process.argv.includes('--check')) {
	let committed = null;
	try {
		committed = readFileSync(out);
	} catch {
		// Missing file falls through to the mismatch report below.
	}
	if (!committed || !committed.equals(glb)) {
		console.error(
			`${out} is ${committed ? 'stale (differs from what this script generates)' : 'missing'} — ` +
				'regenerate with: node tests/e2e/fixtures/generate-vr-fixture.mjs'
		);
		process.exit(1);
	}
	console.log(`ok: ${out} matches this script's output (${glb.length} bytes)`);
} else {
	writeFileSync(out, glb);
	console.log(`wrote ${out} (${glb.length} bytes)`);
}
