import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { getStorage, extFromContentType, isAllowedImageType } from '$lib/server/storage';
import { sniffImageType, isWebmHead } from '$lib/server/storage/sniff';
import { MAX_BUFFER_BYTES } from '$lib/server/storage/buffer';
import { UnscrubbableImageError } from '$lib/server/storage/scrub-metadata';
import { recordUpload, schedule } from '$lib/server/metrics';
import type { RequestHandler } from './$types';

// POST /api/upload  (admin-only via hooks)
// Receives an image file and stores it via the active storage provider
// (UploadThing or R2), returning the public URL. This replaces the previous
// client-direct-to-UploadThing flow so uploads honor whichever provider is active.
export const POST: RequestHandler = async ({ request, platform }) => {
	// Layer 1 of the two-layer size cap (see the block below): reject a body
	// the client DECLARES oversized before formData() materializes it — zero
	// memory cost. 64 KiB of slack covers multipart framing overhead (boundary
	// lines + part headers) so a file exactly at the cap still passes here and
	// is judged precisely by the post-formData check. Absent/unparseable header
	// falls through — no 411; the post-formData check stays the enforcement of
	// record (test harnesses construct Requests without the header).
	const declaredLength = Number(request.headers.get('content-length') ?? NaN);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BUFFER_BYTES + 64 * 1024) {
		error(413, `File too large: ~${declaredLength} bytes declared. Max ${MAX_BUFFER_BYTES}.`);
	}

	const form = await request.formData();
	const file = form.get('file');
	if (!(file instanceof File)) error(400, 'No file provided');

	const folder = (form.get('folder') as string)?.replace(/[^a-z0-9/_-]/gi, '') || 'artwork';

	const db = getDb(platform!.env.DB);
	// Decides which store the bytes land in — must reflect the latest provider,
	// never a cached value, so a just-switched provider takes effect immediately.
	const settings = await getSettings(db, { fresh: true });
	const storage = getStorage(platform?.env, settings);

	// Layer 2 of the size cap (memory rationale lives with the value in
	// $lib/config): the EXACT check, on the file's real size. The two layers:
	// the Content-Length pre-check above rejects declared-oversized bodies at
	// zero memory cost, before formData() materializes anything; this check is
	// precise and catches bodies whose header was absent, unparseable, or
	// understated. Residual exposure: concurrent legitimately-sized uploads
	// each buffer up to the cap, bounded only by admin-gating and the client's
	// sequential batching. What the cap bounds either way: the stored object's
	// size and every downstream copy, keeping fork storage bills predictable.
	// A truly large-body endpoint (e.g. VR avatar models) must read
	// request.body directly instead of formData(), and sets its own cap.
	if (file.size > MAX_BUFFER_BYTES) {
		error(413, `File too large: ${file.size} bytes. Max ${MAX_BUFFER_BYTES}.`);
	}

	const contentType = file.type || 'application/octet-stream';
	// Only store safe raster images — SVG/HTML/other types could execute as
	// active content when served straight from the R2 custom-domain origin —
	// plus video/webm for VR showcase clips (SONA-124): inert in that origin,
	// same reasoning as the sticker media allowlist (ALLOWED_STICKER_TYPES).
	// The webm allowance is SCOPED to the vr-media folder: every other caller
	// of this shared endpoint writes the URL into raster-only columns whose
	// consumers (cdnImage/srcset/<img>) would render a stored video as a
	// permanently broken image.
	const isWebm =
		folder === 'vr-media' && contentType.split(';')[0].trim().toLowerCase() === 'video/webm';
	if (!isAllowedImageType(contentType) && !isWebm) {
		error(415, `Unsupported image type: ${contentType}. Allowed: JPEG, PNG, GIF, WebP, AVIF, WebM.`);
	}
	// Verify the actual leading bytes match the declared type (M7) — the
	// client-supplied content-type above can be spoofed. Sniff a cheap 64-byte
	// head rather than buffering the whole file — big enough that an AVIF ftyp
	// box's compatible_brands (which start at offset 16) are visible.
	const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
	if (isWebm ? !isWebmHead(head) : !isAllowedImageType(sniffImageType(head))) {
		error(415, 'File contents do not match an allowed image type.');
	}
	const ext = extFromContentType(contentType);
	// Store the normalized value the allowlist actually matched (parameters
	// stripped, lowercased) so what was validated is what is used downstream.
	const storedType = contentType.split(';')[0].trim().toLowerCase();
	const key = `${folder}/${crypto.randomUUID()}.${ext}`;

	// Observability (issue #6): record upload health (provider-agnostic — works for
	// R2 and UploadThing alike). Fire-and-forget so it adds no latency; a failure
	// re-throws unchanged after being sampled.
	let putResult;
	try {
		putResult = await storage.put({
			suggestedKey: key,
			body: file.stream(),
			size: file.size,
			contentType: storedType,
			filename: file.name
		});
	} catch (e) {
		// A file whose metadata we cannot strip is the operator's to fix, not a
		// server fault: the storage layer refuses to store a raster it could not
		// walk (SONA-170), and the way out is a re-export, so this is a 422 with
		// an instruction rather than an opaque 500.
		if (e instanceof UnscrubbableImageError) {
			const message = "Couldn't strip metadata from this file. Re-export it and try again.";
			schedule(platform, recordUpload(db, false, { status: 422, message }));
			error(422, message);
		}
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
