import { json } from '@sveltejs/kit';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { stickers } from '$lib/server/db/schema';
import { sniffAnimatedFromUrl } from '$lib/server/animated-raster';
import type { RequestHandler } from './$types';

// Default per-run raster cap: each raster costs one subrequest, and a Workers
// invocation has a subrequest ceiling (~1000 on paid plans). 200 leaves ample
// headroom; huge libraries page with ?afterId=<lastId> across runs.
const DEFAULT_LIMIT = 200;

// POST /api/stickers/backfill-animated[?limit=N&afterId=ID]  (admin-only via hooks)
//
// One-off, idempotent backfill of stickers.is_animated for rows imported before
// the column existed (SONA-123). New imports sniff at download time; this walks
// static-raster rows ('png'/'webp' format — the only formats whose flag isn't
// knowable without the bytes), fetches the stored file via sniffAnimatedFromUrl
// (WebP ANIM / multi-frame GIF walk), and updates rows whose flag is wrong in
// either direction. 'animated' (Lottie) and 'video' rows are stamped true in
// bulk — no fetch needed.
//
// Idempotent and re-runnable: a second run finds nothing to change. A row whose
// file can't be read (sniff null: fetch error/non-2xx) is reported as failed and
// KEEPS its current flag — stamping it static could flip a correct true off.
// Paging: rows are walked in id order; the response's lastId feeds the next
// run's ?afterId until rasters < limit.
export const POST: RequestHandler = async ({ platform, url, fetch }) => {
	const db = getDb(platform!.env.DB);

	const limitRaw = Number(url.searchParams.get('limit'));
	const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;
	const afterRaw = Number(url.searchParams.get('afterId'));
	const afterId = Number.isInteger(afterRaw) && afterRaw > 0 ? afterRaw : 0;

	// Lottie/video rows: always animated, one bulk statement each run (no-op after
	// the first).
	await db
		.update(stickers)
		.set({ isAnimated: true })
		.where(inArray(stickers.format, ['animated', 'video']));

	const rasters = await db
		.select({ id: stickers.id, imageUrl: stickers.imageUrl, isAnimated: stickers.isAnimated })
		.from(stickers)
		.where(and(inArray(stickers.format, ['png', 'webp']), gt(stickers.id, afterId)))
		.orderBy(asc(stickers.id))
		.limit(limit);

	let updated = 0;
	let unchanged = 0;
	const failed: Array<{ id: number; error: string }> = [];

	for (const row of rasters) {
		const sniffed = await sniffAnimatedFromUrl(row.imageUrl, fetch, url.origin);
		if (sniffed === null) {
			failed.push({ id: row.id, error: 'could not fetch stored file' });
			continue;
		}
		if (sniffed === row.isAnimated) {
			unchanged++;
			continue;
		}
		await db.update(stickers).set({ isAnimated: sniffed }).where(eq(stickers.id, row.id));
		updated++;
	}

	const lastId = rasters.length > 0 ? rasters[rasters.length - 1].id : null;
	return json({ rasters: rasters.length, updated, unchanged, failed, lastId });
};
