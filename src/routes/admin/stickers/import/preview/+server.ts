import { error } from '@sveltejs/kit';
import { isTelegramEnabled, downloadFile, stickerMediaType } from '$lib/server/telegram';
import { isAllowedStickerType } from '$lib/server/storage';
import type { RequestHandler } from './$types';

// GET /admin/stickers/import/preview?fileId=<telegram file_id>
// Streams a Telegram sticker's bytes to the import review grid WITHOUT exposing the
// bot token: the only way to fetch a sticker file is
// `api.telegram.org/file/bot<TOKEN>/<path>`, whose token must never reach the
// browser. So the browser asks us, we fetch with the token server-side, and stream
// the bytes back. Admin-only (the /admin guard in hooks.server.ts covers this route).
//
// Only inert media (static raster, webm) is served; animated .tgs is gzipped Lottie
// that won't render in an <img>, so the grid shows a badge for those instead and
// never calls this endpoint for them — we 415 if one slips through.
export const GET: RequestHandler = async ({ url, platform }) => {
	if (!isTelegramEnabled(platform?.env)) error(404, 'Telegram import not configured');

	const fileId = url.searchParams.get('fileId') ?? '';
	// Telegram file_ids are URL-safe base64-ish tokens; bound + charset-check so this
	// can't be coerced into anything but a getFile argument.
	if (!fileId || fileId.length > 512 || !/^[A-Za-z0-9_-]+$/.test(fileId)) {
		error(400, 'Invalid fileId');
	}

	let file;
	try {
		file = await downloadFile(platform?.env, fileId);
	} catch {
		error(502, 'Could not fetch preview from Telegram');
	}

	// Telegram serves stickers as octet-stream; derive the real type from the path.
	const contentType = stickerMediaType(file.filePath);
	if (!isAllowedStickerType(contentType)) error(415, 'Not previewable');

	return new Response(file.bytes, {
		headers: {
			'Content-Type': contentType,
			'Content-Disposition': 'inline',
			// Belt-and-suspenders; the admin response also gets nosniff from hooks.
			'X-Content-Type-Options': 'nosniff'
		}
	});
};
