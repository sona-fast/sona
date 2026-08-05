import { json } from '@sveltejs/kit';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { stickers } from '$lib/server/db/schema';
import { isAnimatedRaster } from '$lib/server/animated-raster';
import type { RequestHandler } from './$types';

// POST /api/stickers/backfill-animated  (admin-only via hooks)
//
// One-off, idempotent backfill of stickers.is_animated for rows imported before
// the column existed (SONA-123). New imports sniff at download time; this walks
// every static-raster row ('png'/'webp' format — the only formats whose flag
// isn't knowable without the bytes), fetches the stored file, sniffs it for
// WebP ANIM / multi-frame GIF, and updates rows whose flag is wrong in either
// direction. 'animated' (Lottie) and 'video' rows are stamped true in bulk —
// no fetch needed.
//
// Idempotent and re-runnable: a second run finds nothing to change. Each raster
// row is wrapped in try/catch so one unfetchable file can't abort the run; those
// rows are reported as failed and keep their current flag.
export const POST: RequestHandler = async ({ platform, url, fetch }) => {
	const db = getDb(platform!.env.DB);

	// Lottie/video rows: always animated, one bulk statement each run (no-op after
	// the first).
	await db
		.update(stickers)
		.set({ isAnimated: true })
		.where(inArray(stickers.format, ['animated', 'video']));

	const rasters = await db
		.select({ id: stickers.id, imageUrl: stickers.imageUrl, isAnimated: stickers.isAnimated })
		.from(stickers)
		.where(inArray(stickers.format, ['png', 'webp']));

	let updated = 0;
	let unchanged = 0;
	const failed: Array<{ id: number; error: string }> = [];

	for (const row of rasters) {
		try {
			// Strict fetch (unlike sniffAnimatedFromUrl's safe-default false): a row
			// we can't read must be reported, not silently stamped "static" — that
			// could flip a correct true flag back off.
			const res = await fetch(new URL(row.imageUrl, url.origin).href);
			if (!res.ok) throw new Error(`fetch ${res.status}`);
			const sniffed = isAnimatedRaster(new Uint8Array(await res.arrayBuffer()));
			if (sniffed === row.isAnimated) {
				unchanged++;
				continue;
			}
			await db.update(stickers).set({ isAnimated: sniffed }).where(eq(stickers.id, row.id));
			updated++;
		} catch (e) {
			failed.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
		}
	}

	return json({ rasters: rasters.length, updated, unchanged, failed });
};
