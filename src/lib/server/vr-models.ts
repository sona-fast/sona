/**
 * Validation helpers for the streaming VR model upload (SONA-124), shared by
 * the /api/admin/vr-model endpoint and its tests. Model files are far beyond
 * what a worker should buffer, so everything here works on the request's
 * declared metadata plus a small PEEKED head — never the materialized body.
 */

// The size cap and the extension parser live in $lib/vr (shared with the admin
// upload UI, which refuses bad/oversized files client-side before sending a
// byte); the endpoint checks the cap against Content-Length BEFORE any body
// byte is read. The extension doubles as the stored model format: VRM 0.x and
// 1.0 share the .vrm container and the head sniff can't cheaply tell them
// apart, so uploads record the generic 'vrm' (the viewer supports both).
export { MAX_VR_MODEL_BYTES, modelExtFromFilename } from '$lib/vr';

// Model files have no registered media type — browsers and our own uploader
// send them as octet-stream; model/gltf-binary shows up for VRM from tools
// that treat it as its glTF container. Anything else (an image type, text,
// html) means the caller isn't sending what it claims.
const ALLOWED_MODEL_CONTENT_TYPES = new Set(['application/octet-stream', 'model/gltf-binary']);

/** Whether a declared content-type is acceptable for a model upload. */
export function isAllowedModelContentType(contentType: string | null | undefined): boolean {
	if (!contentType) return false;
	return ALLOWED_MODEL_CONTENT_TYPES.has(contentType.split(';')[0].trim().toLowerCase());
}

function asciiAt(bytes: Uint8Array, s: string, offset = 0): boolean {
	if (bytes.length < offset + s.length) return false;
	for (let i = 0; i < s.length; i++) {
		if (bytes[offset + i] !== s.charCodeAt(i)) return false;
	}
	return true;
}

/**
 * Detect a model format from the file's leading bytes, or null when the head
 * matches no supported signature (mirrors sniffImageType in storage/sniff.ts).
 *  - VRM is a glTF-binary container: 'glTF' magic at offset 0.
 *  - Binary FBX: the fixed "Kaydara FBX Binary" header.
 *  - ASCII FBX: by convention opens with a "; FBX x.y.z project file" comment —
 *    accept a leading ';' whose first line mentions FBX.
 */
export function sniffModelFormat(bytes: Uint8Array): 'vrm' | 'fbx' | null {
	if (asciiAt(bytes, 'glTF')) return 'vrm';
	if (asciiAt(bytes, 'Kaydara FBX Binary')) return 'fbx';
	if (bytes.length > 0 && bytes[0] === 0x3b /* ';' */) {
		const firstLine = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64)));
		if (firstLine.split('\n')[0].includes('FBX')) return 'fbx';
	}
	return null;
}

/** How many leading bytes the sniff needs ("Kaydara FBX Binary" is 18; 64
 * leaves headroom, matching the /api/upload image sniff). */
export const MODEL_SNIFF_BYTES = 64;

// Re-exported from its own module: the storage scrubbing decorator peeks the
// same way and should not import the VR module to do it.
export { peekStream } from './peek-stream';
