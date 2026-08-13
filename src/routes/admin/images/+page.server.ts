import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { deleteFile } from '$lib/server/storage';
import { images, artists, imageTags, tags, characters } from '$lib/server/db/schema';
import { eq, desc, asc, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { variantAssignmentError, REFERENCE_BECOMES_VARIANT_ERROR } from '$lib/server/variants';
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

	const parentImages = alias(images, 'parent_images');
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
			parentImageId: images.parentImageId,
			variantLabel: images.variantLabel,
			parentTitle: parentImages.title,
			parentId: parentImages.id
		})
		.from(images)
		.leftJoin(artists, eq(images.artistId, artists.id))
		.leftJoin(parentImages, eq(images.parentImageId, parentImages.id))
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

		// Capture URLs before deleting so we can remove the stored files. Deleting a
		// parent cascades its variant rows, so their files must be cleaned up too.
		const image = await db.select({ imageUrl: images.imageUrl }).from(images).where(eq(images.id, id)).get();
		const variantRows = await db
			.select({ imageUrl: images.imageUrl })
			.from(images)
			.where(eq(images.parentImageId, id));

		await db.delete(imageTags).where(eq(imageTags.imageId, id));
		await db.delete(images).where(eq(images.id, id));

		// Delete the underlying files from whichever provider owns them (R2 or UploadThing).
		const urls = [image?.imageUrl, ...variantRows.map((v) => v.imageUrl)].filter(
			(u): u is string => !!u
		);
		if (urls.length > 0) {
			try {
				const settings = await getSettings(db);
				for (const url of urls) {
					await deleteFile(platform?.env, settings, url);
				}
			} catch {
				// Don't fail the row delete if storage cleanup fails.
			}
		}

		return { success: true };
	},
	groupVariants: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();

		const parentId = Number(data.get('parentId'));
		const ids = ((data.get('ids') as string) || '')
			.split(',')
			.map((s) => Number(s.trim()))
			.filter((n) => Number.isInteger(n) && n > 0);
		const childIds = ids.filter((i) => i !== parentId);

		if (!parentId || childIds.length === 0) {
			return fail(400, { error: 'Select a parent and at least one other image' });
		}

		const rows = await db
			.select({ id: images.id, parentImageId: images.parentImageId })
			.from(images)
			.where(inArray(images.id, [parentId, ...childIds]));
		const parent = rows.find((r) => r.id === parentId);
		const childrenOfSelected = await db
			.select({ parentImageId: images.parentImageId })
			.from(images)
			.where(inArray(images.parentImageId, childIds));

		for (const childId of childIds) {
			const child = rows.find((r) => r.id === childId);
			if (!child) return fail(400, { error: 'Image not found' });
			// Re-parenting an existing variant via multi-select is not supported —
			// clear its current link on the edit page first.
			if (child.parentImageId !== null) {
				return fail(400, { error: 'One of the selected images is already a variant' });
			}
			const variantError = variantAssignmentError({
				selfId: childId,
				parent,
				selfHasVariants: childrenOfSelected.some((c) => c.parentImageId === childId)
			});
			if (variantError === 'missing') return fail(400, { error: 'Parent image not found' });
			if (variantError === 'nested')
				return fail(400, { error: 'Variants cannot be nested — the chosen parent is itself a variant' });
			if (variantError === 'has_variants')
				return fail(400, { error: 'One of the selected images has variants of its own' });
		}

		const owner = await db
			.select({ referenceImageId: characters.referenceImageId })
			.from(characters)
			.where(eq(characters.isOwner, true))
			// first owner by name — must match the loads' find() over name-ordered characters
			.orderBy(characters.name)
			.get();
		if (owner?.referenceImageId != null && childIds.includes(owner.referenceImageId))
			return fail(400, { error: REFERENCE_BECOMES_VARIANT_ERROR });

		await db.update(images).set({ parentImageId: parentId }).where(inArray(images.id, childIds));

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
