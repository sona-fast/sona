import { getReadDb } from '$lib/server/db';
import { images, artists, imageTags, tags } from '$lib/server/db/schema';
import { eq, desc, and, notInArray, inArray, sql } from 'drizzle-orm';
import { getSettings, settingsFallback } from '$lib/server/settings';
import { withTimeout } from '$lib/server/timeout';
import type { PageServerLoad } from './$types';

// Bound each D1 read so a latency spike degrades the homepage to a fast page
// with fewer images instead of hanging until the edge returns a 524.
const READ_TIMEOUT_MS = 5000;

export const load: PageServerLoad = async ({ platform, url }) => {
	// Read-only path: route to a D1 read replica when replication is enabled.
	const db = getReadDb(platform!.env.DB);

	// The homepage escapes the (public) layout (+page@), so that layout's
	// settings load doesn't run here — read settings directly (cached
	// per-isolate, usually zero round-trips).
	const settings = await withTimeout(getSettings(db), READ_TIMEOUT_MS, settingsFallback());

	// The threePath splash is a standalone hub page — no image queries needed.
	if (settings.landingLayout === 'threePath') {
		return { settings, recentImages: [], mosaicImageUrls: [], host: url.host };
	}

	const RECENT_COUNT = 8;
	const MOSAIC_TOTAL = 40;

	// Round-trip 1 — the two independent "most recent" queries in one batch.
	const batch1 = db.batch([
		db
			.select({
				id: images.id,
				title: images.title,
				slug: images.slug,
				imageUrl: images.imageUrl,
				thumbnailUrl: images.thumbnailUrl,
				nsfw: images.nsfw,
				artistName: artists.name
			})
			.from(images)
			.leftJoin(artists, eq(images.artistId, artists.id))
			.where(eq(images.published, true))
			.orderBy(desc(images.createdAt))
			.limit(RECENT_COUNT),
		// Mosaic banner: the most recent SFW images up front (random fill added below).
		db
			.select({ id: images.id, imageUrl: images.imageUrl })
			.from(images)
			.where(and(eq(images.nsfw, false), eq(images.published, true)))
			.orderBy(desc(images.createdAt))
			.limit(RECENT_COUNT)
	]);
	// On a D1 stall, degrade to an empty homepage rather than a 524.
	const [recentImages, recentMosaic] = await withTimeout(
		batch1,
		READ_TIMEOUT_MS,
		[[], []] as Awaited<typeof batch1>
	);

	const imageIds = recentImages.map((img) => img.id);
	const recentIds = recentMosaic.map((r) => r.id);
	const remainingSlots = Math.max(0, MOSAIC_TOTAL - recentMosaic.length);

	// Round-trip 2 — tags for just the recent images, plus the random mosaic fill.
	// Previously the tags query scanned the ENTIRE image_tags⋈tags join on every
	// homepage load (no WHERE filter) — the main driver of rows_read. Scope it to
	// the images we actually render. Both queries depend only on round-trip 1, so
	// they batch together. (inArray([]) and a notInArray-less fallback keep both
	// queries valid when the catalog is empty, so the batch is always a 2-tuple.)
	const batch2 = db.batch([
		db
			.select({ imageId: imageTags.imageId, tagName: tags.name })
			.from(imageTags)
			.innerJoin(tags, eq(imageTags.tagId, tags.id))
			.where(inArray(imageTags.imageId, imageIds)),
		db
			.select({ imageUrl: images.imageUrl })
			.from(images)
			.where(
				recentIds.length > 0
					? and(
							eq(images.nsfw, false),
							eq(images.published, true),
							notInArray(images.id, recentIds)
						)
					: and(eq(images.nsfw, false), eq(images.published, true))
			)
			.orderBy(sql`RANDOM()`)
			.limit(remainingSlots)
	]);
	// Tags/mosaic-fill are enhancements — degrade them silently on a stall.
	const [allImageTags, randomMosaic] = await withTimeout(
		batch2,
		READ_TIMEOUT_MS,
		[[], []] as Awaited<typeof batch2>
	);

	// First tag per image (for the recent-images grid).
	const firstTagByImage: Record<number, string> = {};
	for (const it of allImageTags) {
		if (!firstTagByImage[it.imageId]) {
			firstTagByImage[it.imageId] = it.tagName;
		}
	}

	const imagesWithTags = recentImages.map((img) => ({
		...img,
		tag: firstTagByImage[img.id] || undefined
	}));

	const mosaicImageUrls = [
		...recentMosaic.map((img) => img.imageUrl),
		...randomMosaic.map((img) => img.imageUrl)
	];

	return {
		recentImages: imagesWithTags,
		mosaicImageUrls,
		settings,
		host: url.host
	};
};
