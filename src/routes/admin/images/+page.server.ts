import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { deleteFile } from '$lib/server/storage';
import { images, artists, imageTags, tags } from '$lib/server/db/schema';
import { eq, desc, asc, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDb(platform!.env.DB);

	const sort = url.searchParams.get('sort') || 'commissioned';
	const dir = url.searchParams.get('dir') || 'desc';
	const page = Math.max(1, Number(url.searchParams.get('page') || 1));
	const perPage = 20;

	const orderCol = sort === 'uploaded' ? images.createdAt : images.commissionedAt;
	const orderDir = dir === 'asc' ? asc(orderCol) : desc(orderCol);

	const totalResult = await db
		.select({ count: sql<number>`COUNT(*)` })
		.from(images)
		.get();
	const total = totalResult?.count || 0;

	const allImages = await db
		.select({
			id: images.id,
			title: images.title,
			slug: images.slug,
			imageUrl: images.imageUrl,
			thumbnailUrl: images.thumbnailUrl,
			nsfw: images.nsfw,
			published: images.published,
			commissionedAt: images.commissionedAt,
			createdAt: images.createdAt,
			artistName: artists.name,
		})
		.from(images)
		.leftJoin(artists, eq(images.artistId, artists.id))
		.orderBy(orderDir)
		.limit(perPage)
		.offset((page - 1) * perPage);

	// Get tags for each image
	const imageIds = allImages.map((img) => img.id);
	let tagsByImage: Record<number, string[]> = {};

	if (imageIds.length > 0) {
		const allImageTags = await db
			.select({
				imageId: imageTags.imageId,
				tagName: tags.name
			})
			.from(imageTags)
			.innerJoin(tags, eq(imageTags.tagId, tags.id));

		for (const it of allImageTags) {
			if (!tagsByImage[it.imageId]) tagsByImage[it.imageId] = [];
			tagsByImage[it.imageId].push(it.tagName);
		}
	}

	const imagesWithTags = allImages.map((img) => ({
		...img,
		tags: tagsByImage[img.id] || []
	}));

	return { images: imagesWithTags, sort, dir, page, total, totalPages: Math.ceil(total / perPage) };
};

export const actions = {
	delete: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));

		if (!id) return fail(400, { error: 'Image ID is required' });

		// Capture the URL before deleting so we can remove the stored file.
		const image = await db.select({ imageUrl: images.imageUrl }).from(images).where(eq(images.id, id)).get();

		await db.delete(imageTags).where(eq(imageTags.imageId, id));
		await db.delete(images).where(eq(images.id, id));

		// Delete the underlying file from whichever provider owns it (R2 or UploadThing).
		if (image?.imageUrl) {
			try {
				const settings = await getSettings(db);
				await deleteFile(platform?.env, settings, image.imageUrl);
			} catch {
				// Don't fail the row delete if storage cleanup fails.
			}
		}

		return { success: true };
	},
	togglePublished: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!id) return fail(400, { error: 'Image ID is required' });

		const row = await db.select({ published: images.published }).from(images).where(eq(images.id, id)).get();
		if (!row) return fail(404, { error: 'Image not found' });

		await db.update(images).set({ published: !row.published }).where(eq(images.id, id));
		return { success: true };
	}
} satisfies Actions;
