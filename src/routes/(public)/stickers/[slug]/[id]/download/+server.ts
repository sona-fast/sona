import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { stickers, stickerPacks } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { RateLimiter } from '$lib/server/rate-limit';
import { isAnimatedRaster } from '$lib/server/animated-raster';
import { originalExt, stickerDownloadOptions } from '$lib/sticker-download';
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
// while a sustained flood is still bounded. Note the ?format=png path costs TWO
// subrequests (the buffered original for the animation sniff + the transform
// attempt); the cap's headroom absorbs that without charging extra tokens.
const downloadLimiter = new RateLimiter(200, 60_000); // 200 downloads / min / IP

// Cap on what the converting path will buffer for the animation sniff. Telegram
// static stickers are ≤~512KB, but MANUAL uploads can reach MAX_BUFFER_BYTES
// (64MB — see $lib/server/storage/buffer.ts), and buffering that unboundedly on
// a public, only-rate-limited endpoint is a memory-amplification risk. Anything
// declaring more than this streams through untouched — a >1MB static raster
// then simply never converts, which is acceptable.
const MAX_CONVERT_BYTES = 1_000_000;

// Map a file extension to the Content-Type we serve it with. Anything unknown
// falls back to a generic octet-stream so the browser still saves the bytes.
const CONTENT_TYPES: Record<string, string> = {
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webm: 'video/webm',
	json: 'application/json'
};

/**
 * The absolute http(s) URL to fetch-with-transform, or null when row.imageUrl
 * isn't transformable. Root-relative stored URLs (/img/<key>) resolve against
 * the request origin; anything unparseable or non-http(s) is refused. (No '..'
 * concern — new URL() normalizes dot segments.)
 */
function transformableUrl(imageUrl: string, origin: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(imageUrl, origin);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
	return parsed.href;
}

/** The host row.imageUrl points at, for logging. Host only — the path can carry
 * a signed query and has no diagnostic value here. */
function sourceHost(imageUrl: string, origin: string): string {
	try {
		return new URL(imageUrl, origin).host;
	} catch {
		return 'unparseable';
	}
}

// GET /stickers/[slug]/[id]/download[?format=png]
// Streams a sticker's high-res file as a forced download (Content-Disposition).
// A plain <a download> to the R2 custom domain wouldn't work (cross-origin downloads are
// ignored by browsers), so we proxy same-origin.
//
// Without ?format we serve the ORIGINAL stored bytes untouched, so animated
// WebP/GIF keep their animation. With ?format=png — offered by the UI only for
// static rasters that don't animate (see stickerDownloadOptions, the shared
// source of truth this handler validates against) — we first buffer + sniff the
// original (a stale pre-backfill is_animated flag must never let the transform
// flatten an animated file), then proxy through the zone's Cloudflare image
// transform. When the transform can't run (dev server, a zone without
// transforms enabled, off-zone storage 403s — see SONA-21) we fall back to the
// buffered original bytes under the original filename: correct bytes beat a 5xx.
export const GET: RequestHandler = async ({ params, url, platform, fetch, getClientAddress }) => {
	if (!downloadLimiter.check(getClientAddress(), Date.now())) {
		error(429, 'Too many downloads, please slow down.');
	}

	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Sticker not found');

	const db = getReadDb(platform!.env.DB);
	const row = await db
		.select({ imageUrl: stickers.imageUrl, format: stickers.format, isAnimated: stickers.isAnimated })
		.from(stickers)
		.innerJoin(stickerPacks, eq(stickers.packId, stickerPacks.id))
		.where(
			and(eq(stickers.id, id), eq(stickerPacks.slug, params.slug), eq(stickerPacks.published, true))
		)
		.get();
	if (!row) error(404, 'Sticker not found');

	// Validate ?format against what this sticker can actually offer. The UI never
	// generates an invalid link, so any mismatch is a hand-crafted URL → 400.
	const requested = url.searchParams.get('format');
	if (requested && !stickerDownloadOptions(row).some((o) => o.kind === requested)) {
		error(400, 'This sticker cannot be converted to that format.');
	}

	const ext = originalExt(row);
	const originalName = `${params.slug}-${id}.${ext}`;
	const converting = requested === 'png';

	if (converting) {
		// Buffer the original FIRST and sniff its bytes: a pre-backfill row can
		// carry a stale is_animated=0 while the stored file actually animates, and
		// the transform would "succeed" by flattening it to its first frame. The
		// buffer doubles as the transform-failure fallback below without a second
		// fetch — but it's bounded by MAX_CONVERT_BYTES: anything declaring more
		// streams through untouched like the plain path.
		const orig = await fetch(row.imageUrl);
		if (!orig.ok || !orig.body) error(502, 'Could not fetch sticker file');
		const origType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
		// Only a declared length at or under the cap earns the buffering path. A
		// chunked response carries no content-length at all, and Number(null) is 0
		// — which sailed under the cap and buffered the body unbounded, defeating
		// the guard exactly when the size was unknown. Same for an unparseable
		// header (NaN, and every comparison against NaN is false).
		const declaredBytes = Number(orig.headers.get('content-length'));
		const undeclared = !Number.isFinite(declaredBytes) || declaredBytes <= 0;
		if (undeclared || declaredBytes > MAX_CONVERT_BYTES) {
			// An over-cap file is a deliberate decision; a missing or unparseable
			// length is a storage backend behaving differently than assumed, and the
			// user just silently got webp bytes from a ?format=png link. Say so in the
			// Workers logs so the downgrade is diagnosable.
			if (undeclared) {
				console.warn(
					`sticker download: ${sourceHost(row.imageUrl, url.origin)} declared no usable content-length, skipped png conversion`
				);
			}
			// Original bytes under a ?format=png URL, exactly like the two fallbacks
			// below — so it gets their no-store treatment, or the edge would pin webp
			// bytes to the png URL for everyone.
			return fileResponse(orig.body, originalName, origType, orig.headers.get('etag'), 'private, no-store');
		}
		let origBytes: Uint8Array<ArrayBuffer>;
		try {
			origBytes = await readCapped(orig.body, MAX_CONVERT_BYTES);
		} catch {
			error(502, 'Could not fetch sticker file');
		}
		if (isAnimatedRaster(origBytes)) {
			// Stale flag: refuse to flatten. Serve the original bytes under the
			// original filename, uncacheable (same semantics as the fallback
			// below) — the backfill corrects the flag and removes the PNG option.
			return fileResponse(origBytes, originalName, origType, orig.headers.get('etag'), 'private, no-store');
		}

		// Zone image transform via fetch options (`cf.image`), the documented
		// in-Worker mechanism. The /cdn-cgi/image/<url> form CANNOT work from
		// inside the Worker: a subrequest to the Worker's own zone goes straight
		// to the origin, where that path doesn't exist — verified live on
		// sparky.ink, where an external /cdn-cgi/image request converts fine but
		// the in-Worker one 404s and fell back. globalThis.fetch, NOT the event
		// fetch, so the request leaves the isolate without the caller's cookies.
		// Reject anything that didn't produce a PNG (transforms disabled on the
		// zone → cf.image is ignored and the original passes through, an error
		// page, an HTML challenge) and fall back to the buffered original.
		const source = transformableUrl(row.imageUrl, url.origin);
		if (source) {
			try {
				const res = await globalThis.fetch(source, {
					cf: { image: { format: 'png' } }
				} as RequestInit);
				if (res.ok && res.body && res.headers.get('content-type')?.startsWith('image/png')) {
					return fileResponse(res.body, `${params.slug}-${id}.png`, 'image/png', res.headers.get('etag'));
				}
				// Drain the rejected body so the connection is released.
				await res.body?.cancel();
			} catch {
				// fall through to the buffered original
			}
		}

		// Transform couldn't run — serve the already-buffered original bytes. Must
		// not be edge-cached: the failure may be transient, and caching it would
		// pin webp bytes to the png URL for everyone (hooks.server.ts honors an
		// explicit Cache-Control instead of stamping its public s-maxage default).
		return fileResponse(origBytes, originalName, origType, orig.headers.get('etag'), 'private, no-store');
	}

	const res = await fetch(row.imageUrl);
	if (!res.ok || !res.body) error(502, 'Could not fetch sticker file');
	return fileResponse(
		res.body,
		originalName,
		CONTENT_TYPES[ext] ?? 'application/octet-stream',
		res.headers.get('etag')
	);
};

/**
 * Read a body into memory, refusing past `limit` bytes. content-length is the
 * origin's claim, not a fact: the declared-size check above is what picks this
 * path, and a response that declares 4 bytes then sends 50MB would buffer all
 * of it. Bytes already read are dropped and the caller 502s — by the time the
 * lie is visible the stream is partly consumed, so streaming through instead is
 * no longer an option.
 */
async function readCapped(
	body: ReadableStream<Uint8Array>,
	limit: number
): Promise<Uint8Array<ArrayBuffer>> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new Error('origin body exceeded its declared length');
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

/**
 * @param etag The upstream ETag for these exact bytes, forwarded as this
 * response's validator. This handler never answers a conditional request itself
 * — nothing here reads If-None-Match — so the validator is for the Cloudflare
 * edge, which can revalidate a cached public response instead of pulling the
 * file again. Last-Modified is deliberately not forwarded: the Cache-Control
 * below gives the browser no freshness lifetime of its own (s-maxage binds
 * shared caches only), so a Last-Modified turns on heuristic caching and Chrome
 * stops revalidating altogether.
 *
 * @param cacheControl Match the caching the hooks stamp gives public non-HTML
 * responses: a short shared-cache TTL (5 min) + SWR, NOT a browser-cached hour —
 * a takedown must propagate promptly, so downloads never get a long max-age.
 */
function fileResponse(
	body: BodyInit,
	filename: string,
	contentType: string,
	etag: string | null,
	cacheControl = 'public, s-maxage=300, stale-while-revalidate=3600'
): Response {
	const headers = new Headers({
		'Content-Type': contentType,
		'Content-Disposition': `attachment; filename="${filename}"`,
		'Cache-Control': cacheControl
	});
	if (etag) headers.set('etag', etag);
	return new Response(body, { headers });
}
