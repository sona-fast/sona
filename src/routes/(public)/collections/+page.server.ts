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
			// First ≤4 image urls (newest first) as a JSON array, aggregated in SQLite so
			// each collection's mosaic comes back in the single list query — no N+1.
			previewImagesJson: sql<string>`(SELECT json_group_array(image_url) FROM (SELECT images.image_url FROM images WHERE images.collection_id = collections.id AND images.published = 1 ORDER BY images.created_at DESC LIMIT 4))`
		})
		.from(collections)
		.orderBy(collections.name);

	const collectionsWithPreviews = allCollections.map(({ previewImagesJson, ...c }) => ({
		...c,
		previewImages: (JSON.parse(previewImagesJson || '[]') as string[]).filter(Boolean)
	}));

	return { collections: collectionsWithPreviews };
};
