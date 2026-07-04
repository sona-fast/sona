import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { collections, images, artists, imageTags, tags } from '$lib/server/db/schema';
import { eq, desc, and, isNull } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform }) => {
	// read replica (eventually consistent); admin writes use the primary
	const db = getReadDb(platform!.env.DB);

	const collection = await db
		.select()
		.from(collections)
		.where(eq(collections.slug, params.slug))
		.get();

	if (!collection) error(404, 'Collection not found');

	const collectionImages = await db
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
		.where(and(eq(images.collectionId, collection.id), eq(images.published, true), isNull(images.parentImageId)))
		.orderBy(desc(images.createdAt));

	// Get first tag per image
	let firstTagByImage: Record<number, string> = {};
	if (collectionImages.length > 0) {
		const allImageTags = await db
			.select({ imageId: imageTags.imageId, tagName: tags.name })
			.from(imageTags)
			.innerJoin(tags, eq(imageTags.tagId, tags.id));

		for (const it of allImageTags) {
			if (!firstTagByImage[it.imageId]) {
				firstTagByImage[it.imageId] = it.tagName;
			}
		}
	}

	const imagesWithTags = collectionImages.map((img) => ({
		...img,
		tag: firstTagByImage[img.id] || undefined
	}));

	return { collection, images: imagesWithTags };
};
