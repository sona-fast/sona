import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { getStorage, extFromContentType, isAllowedImageType } from '$lib/server/storage';
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

	const contentType = file.type || 'application/octet-stream';
	// Only store safe raster images. SVG/HTML/other types could execute as active
	// content when served from the cdn.sparky.ink origin.
	if (!isAllowedImageType(contentType)) {
		error(415, `Unsupported image type: ${contentType}. Allowed: JPEG, PNG, GIF, WebP, AVIF.`);
	}
	const ext = extFromContentType(contentType);
	const key = `${folder}/${crypto.randomUUID()}.${ext}`;

	const { url } = await storage.put({ suggestedKey: key, body: file.stream(), contentType, filename: file.name });
	// R2 in dev returns a root-relative '/img/...' URL; store it absolute so it
	// survives sanitizeUrl and renders the same as prod (cdn.sparky.ink).
	const absoluteUrl = url.startsWith('/') ? new URL(url, request.url).href : url;
	return json({ url: absoluteUrl, size: file.size });
};
