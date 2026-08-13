import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { getStorage } from '$lib/server/storage';
import {
	MAX_VR_MODEL_BYTES,
	MODEL_SNIFF_BYTES,
	isAllowedModelContentType,
	modelExtFromFilename,
	peekStream,
	sniffModelFormat
} from '$lib/server/vr-models';
import { vrPublishingEnabled } from '$lib/server/vr-gate';
import type { RequestHandler } from './$types';

// POST /api/admin/vr-model?filename=<name>.vrm|.fbx  (admin-only via hooks —
// everything under /api requires the admin session except the short exempt list
// in hooks.server.ts, which is the authoritative one).
//
// Streaming counterpart of /api/upload for VR avatar model files (SONA-124).
// Models are far beyond MAX_BUFFER_BYTES, so the RAW body is streamed — never
// request.formData() (which materializes the file) and never bufferStream. The
// declared Content-Length is REQUIRED: it is checked against the size cap
// before a single body byte is read, and passed to storage.put() as `size` so
// the landed SONA-136 contract streams end-to-end and fails the put on a
// length mismatch (a lying header can't store a truncated/oversized object).
//
// The caller stores the returned { url, size, format } on the avatar row via
// the create/edit form.
export const POST: RequestHandler = async ({ request, url, platform }) => {
	const db = getDb(platform!.env.DB);

	// Gate enforcement (SONA-124): uploading a model is part of creating/
	// publishing, which is supporter-only until the flag GAs. The disabled
	// dropzone is presentation; this is the enforcement.
	if (!(await vrPublishingEnabled(db, platform?.env))) {
		error(403, 'VR avatars are in early access — uploading models needs a valid supporter key until they open for everyone.');
	}

	const lengthHeader = request.headers.get('content-length');
	const size = lengthHeader === null ? NaN : Number(lengthHeader);
	if (!Number.isInteger(size) || size <= 0) {
		error(411, 'Content-Length is required for model uploads.');
	}
	if (size > MAX_VR_MODEL_BYTES) {
		error(413, `File too large: ${size} bytes. Max ${MAX_VR_MODEL_BYTES}.`);
	}

	const filename = url.searchParams.get('filename');
	const ext = modelExtFromFilename(filename);
	if (!ext) {
		error(415, 'Unsupported model file. Allowed: .vrm, .fbx.');
	}
	if (!isAllowedModelContentType(request.headers.get('content-type'))) {
		error(415, 'Unsupported content-type for a model upload.');
	}

	if (!request.body) {
		error(400, 'No file provided');
	}

	// Magic-byte check on a PEEKED head (VRM = glTF binary magic, FBX binary/
	// ASCII header) — the extension and content-type above are caller-supplied.
	// peekStream never materializes the body; the storage put below still
	// streams (SONA-136 contract: ReadableStream + declared size).
	const { head, stream } = await peekStream(request.body, MODEL_SNIFF_BYTES);
	const sniffed = sniffModelFormat(head);
	// The extension doubles as the stored format ('vrm' | 'fbx'): VRM 0.x and
	// 1.0 share the .vrm container and the head sniff can't cheaply tell them
	// apart, so uploads record the generic 'vrm' (the viewer supports both).
	if (sniffed !== ext) {
		error(415, 'File contents do not match a VRM or FBX model.');
	}

	// Which store the bytes land in must reflect the latest provider (same
	// reasoning as /api/upload).
	const settings = await getSettings(db, { fresh: true });
	const storage = getStorage(platform?.env, settings);

	const { url: storedUrl } = await storage.put({
		suggestedKey: `vr-models/${crypto.randomUUID()}.${ext}`,
		body: stream,
		size,
		contentType: 'application/octet-stream',
		filename: filename!
	});

	// R2 in dev returns a root-relative '/img/...' URL; store it absolute so it
	// survives sanitizeUrl and renders the same as prod (same as /api/upload).
	const absoluteUrl = storedUrl.startsWith('/') ? new URL(storedUrl, request.url).href : storedUrl;
	return json({ url: absoluteUrl, size, format: ext });
};
