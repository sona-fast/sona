import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { getStorage, extFromContentType, isAllowedImageType } from '$lib/server/storage';
import { sniffImageType } from '$lib/server/storage/sniff';
import { MAX_BUFFER_BYTES } from '$lib/server/storage/buffer';
import { recordUpload, schedule } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

// POST /api/upload  (admin-only via hooks)
// Receives an image file and stores it via the active storage provider
// (UploadThing or R2), returning the public URL. This replaces the previous
// client-direct-to-UploadThing flow so uploads honor whichever provider is active.
export const POST: RequestHandler = async ({ request, platform }) => {
	const form = await request.formData();
	const file = form.get('file');
	if (!(file instanceof File)) error(400, 'No file provided');

	const folder = (form.get('folder') as string)?.replace(/[^a-z0-9/_-]/gi, '') || 'artwork';

	const db = getDb(platform!.env.DB);
	// Decides which store the bytes land in — must reflect the latest provider,
	// never a cached value, so a just-switched provider takes effect immediately.
	const settings = await getSettings(db, { fresh: true });
	const storage = getStorage(platform?.env, settings);

	// Cap the stored size (M8) so a huge upload can't OOM the isolate while buffering.
	if (file.size > MAX_BUFFER_BYTES) {
		error(413, `File too large: ${file.size} bytes. Max ${MAX_BUFFER_BYTES}.`);
	}

	const contentType = file.type || 'application/octet-stream';
	// Only store safe raster images. SVG/HTML/other types could execute as active
	// content when served straight from the R2 custom-domain origin.
	if (!isAllowedImageType(contentType)) {
		error(415, `Unsupported image type: ${contentType}. Allowed: JPEG, PNG, GIF, WebP, AVIF.`);
	}
	// Verify the actual leading bytes match an allowed raster type (M7) — the
	// client-supplied content-type above can be spoofed. Sniff a cheap 64-byte
	// head rather than buffering the whole file — big enough that an AVIF ftyp
	// box's compatible_brands (which start at offset 16) are visible.
	const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
	if (!isAllowedImageType(sniffImageType(head))) {
		error(415, 'File contents do not match an allowed image type.');
	}
	const ext = extFromContentType(contentType);
	const key = `${folder}/${crypto.randomUUID()}.${ext}`;

	// Observability (issue #6): record upload health (provider-agnostic — works for
	// R2 and UploadThing alike). Fire-and-forget so it adds no latency; a failure
	// re-throws unchanged after being sampled.
	let putResult;
	try {
		putResult = await storage.put({ suggestedKey: key, body: file.stream(), contentType, filename: file.name });
	} catch (e) {
		schedule(platform, recordUpload(db, false, {
			status: 500,
			message: e instanceof Error ? e.message : 'storage put failed'
		}));
		throw e;
	}
	schedule(platform, recordUpload(db, true));
	const { url } = putResult;
	// R2 in dev returns a root-relative '/img/...' URL; store it absolute so it
	// survives sanitizeUrl and renders the same as prod (the R2 custom domain).
	const absoluteUrl = url.startsWith('/') ? new URL(url, request.url).href : url;
	return json({ url: absoluteUrl, size: file.size });
};
