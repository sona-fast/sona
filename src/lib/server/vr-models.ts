/**
 * Validation helpers for the streaming VR model upload (SONA-124), shared by
 * the /api/admin/vr-model endpoint and its tests. Model files are far beyond
 * what a worker should buffer, so everything here works on the request's
 * declared metadata plus a small PEEKED head — never the materialized body.
 */

// The size cap itself lives in $lib/vr (shared with the admin upload UI, which
// refuses oversized files client-side before sending a byte); the endpoint
// checks it against Content-Length BEFORE any body byte is read.
export { MAX_VR_MODEL_BYTES } from '$lib/vr';

/** Stored model format for an accepted file extension. VRM 0.x and 1.0 share
 * the .vrm container; the head sniff can't cheaply tell them apart, so
 * uploads record the generic 'vrm' (the viewer supports both). */
export const MODEL_FORMAT_BY_EXT: Record<string, 'vrm' | 'fbx'> = {
	vrm: 'vrm',
	fbx: 'fbx'
};

/** The .vrm/.fbx extension of an uploaded filename, or null when it carries
 * none we accept. Case-insensitive; the extension is the LAST dot segment. */
export function modelExtFromFilename(filename: string | null | undefined): 'vrm' | 'fbx' | null {
	if (!filename) return null;
	const dot = filename.lastIndexOf('.');
	if (dot <= 0) return null;
	const ext = filename.slice(dot + 1).toLowerCase();
	return ext === 'vrm' || ext === 'fbx' ? ext : null;
}

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

/**
 * Peek the first `n` bytes of a stream WITHOUT materializing the body: reads
 * whole chunks off the reader until `n` bytes (or EOF), then returns a new
 * stream that replays those chunks before handing over to the untouched
 * remainder. Memory held is at most the read chunks (typically one), never
 * the file — the storage put still streams end-to-end.
 */
export async function peekStream(
	stream: ReadableStream<Uint8Array>,
	n: number
): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let len = 0;
	while (len < n) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		len += value.length;
	}
	const head = new Uint8Array(Math.min(len, n));
	let off = 0;
	for (const c of chunks) {
		if (off >= head.length) break;
		head.set(c.subarray(0, Math.min(c.length, head.length - off)), off);
		off += c.length;
	}
	let replayIndex = 0;
	const replayed = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (replayIndex < chunks.length) {
				controller.enqueue(chunks[replayIndex++]);
				return;
			}
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
	return { head, stream: replayed };
}
