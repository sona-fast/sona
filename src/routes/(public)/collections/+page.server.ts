import { getReadDb } from '$lib/server/db';
import { collections, images } from '$lib/server/db/schema';
import { sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	// read replica (eventually consistent); admin writes use the primary
	const db = getReadDb(platform!.env.DB);

	const allCollections = await db
		.select({
			id: collections.id,
			name: collections.name,
			slug: collections.slug,
			coverImageUrl: collections.coverImageUrl,
			artworkCount: sql<number>`(SELECT COUNT(*) FROM images WHERE images.collection_id = collections.id AND images.published = 1)`,
			// First ≤4 images (SFW first, then newest) as a JSON array, aggregated in
			// SQLite so each collection's mosaic comes back in the single list query — no
			// N+1. nsfw rides along so a fully-NSFW collection can fall back to a masked
			// (blurred) mosaic instead of showing the raw image.
			previewImagesJson: sql<string>`(SELECT json_group_array(json_object('url', image_url, 'nsfw', nsfw)) FROM (SELECT images.image_url, images.nsfw FROM images WHERE images.collection_id = collections.id AND images.published = 1 ORDER BY images.nsfw ASC, images.created_at DESC LIMIT 4))`
		})
		.from(collections)
		.orderBy(collections.name);

	const collectionsWithPreviews = allCollections.map(({ previewImagesJson, ...c }) => {
		const previews = (JSON.parse(previewImagesJson || '[]') as { url: string; nsfw: number }[])
			.filter((p) => p?.url)
			.map((p) => ({ url: p.url, nsfw: !!p.nsfw }));
		// Prefer SFW-only mosaics; only a collection with no SFW images at all shows
		// its NSFW previews (rendered blurred by the page).
		const sfw = previews.filter((p) => !p.nsfw);
		return { ...c, previewImages: sfw.length > 0 ? sfw : previews };
	});

	return { collections: collectionsWithPreviews };
};
