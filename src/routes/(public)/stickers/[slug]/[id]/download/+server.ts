import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { stickers, stickerPacks } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { RateLimiter } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';

// Throttle the unauthenticated download proxy (M10). Each GET makes the worker
// fetch+stream the whole file, so an unthrottled loop amplifies bandwidth/cost.
// A cross-origin redirect to the R2 domain would drop the <a download> forced
// download (and R2 custom domains can't attach Content-Disposition without
// re-storing objects), so we keep the same-origin proxy and cap it per-IP.
// Best-effort/per-isolate — see RateLimiter; a hard global cap is a CF rule.
// Cap sized to fit saving one full imported pack in a burst: Telegram packs run
// up to ~120 stickers, each saved via its own per-sticker download link, so a
// legit "save whole pack" (or a few users behind one NAT) stays under the cap
// while a sustained flood is still bounded.
const downloadLimiter = new RateLimiter(200, 60_000); // 200 downloads / min / IP

// Map a file extension to the Content-Type we serve it with. Anything unknown
// falls back to a generic octet-stream so the browser still saves the bytes.
const CONTENT_TYPES: Record<string, string> = {
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg'
};

// GET /stickers/[slug]/[id]/download
// Streams a sticker's high-res file as a forced download (Content-Disposition).
// A plain <a download> to the R2 custom domain wouldn't work (cross-origin downloads are
// ignored by browsers), so we proxy same-origin. We always serve the ORIGINAL
// stored bytes: routing static stickers through a Cloudflare Image transform to
// PNG would flatten animated WebP/GIF down to a single frame. The original is
// already high-res, so there's nothing to gain from the transform.
export const GET: RequestHandler = async ({ params, platform, fetch, getClientAddress }) => {
	if (!downloadLimiter.check(getClientAddress(), Date.now())) {
		error(429, 'Too many downloads, please slow down.');
	}

	const db = getReadDb(platform!.env.DB);
	const row = await db
		.select({ imageUrl: stickers.imageUrl, format: stickers.format })
		.from(stickers)
		.innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
		.where(
			and(eq(stickers.id, Number(params.id)), eq(stickerPacks.slug, params.slug), eq(stickerPacks.published, true))
		)
		.get();
	if (!row) error(404, 'Sticker not found');

	const fetchUrl = row.imageUrl;
	let ext: string;
	let contentType: string;

	if (row.format === 'video') {
		ext = 'webm';
		contentType = 'video/webm';
	} else if (row.format === 'animated') {
		ext = 'json';
		contentType = 'application/json';
	} else {
		// Static raster (png/webp, possibly an animated WebP or a GIF). Serve the
		// original file untouched so animation survives, picking the extension and
		// Content-Type from the stored file rather than forcing PNG.
		const path = (() => {
			try {
				return new URL(row.imageUrl).pathname;
			} catch {
				return row.imageUrl;
			}
		})();
		const match = path.toLowerCase().match(/\.([a-z0-9]+)$/);
		ext = match?.[1] ?? (row.format === 'png' ? 'png' : 'webp');
		contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
	}

	const res = await fetch(fetchUrl);
	if (!res.ok || !res.body) error(502, 'Could not fetch sticker file');

	return new Response(res.body, {
		headers: {
			'Content-Type': contentType,
			'Content-Disposition': `attachment; filename="${params.slug}-${params.id}.${ext}"`,
			'Cache-Control': 'public, max-age=3600'
		}
	});
};
