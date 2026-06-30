import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { collections, images } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import type { Actions, PageServerLoad } from './$types';

function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);

	const allCollections = await db
		.select({
			id: collections.id,
			name: collections.name,
			slug: collections.slug,
			coverImageUrl: collections.coverImageUrl,
			createdAt: collections.createdAt,
			artworkCount: sql<number>`(SELECT COUNT(*) FROM images WHERE images.collection_id = collections.id)`,
			latestImageUrl: sql<string>`(SELECT images.image_url FROM images WHERE images.collection_id = collections.id ORDER BY images.created_at DESC LIMIT 1)`
		})
		.from(collections)
		.orderBy(collections.name);

	// Get images for cover selection
	const allImages = await db
		.select({ id: images.id, title: images.title, imageUrl: images.imageUrl, collectionId: images.collectionId })
		.from(images)
		.orderBy(images.title);

	return { collections: allCollections, images: allImages };
};

export const actions = {
	create: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const name = sanitizeText(data.get('name') as string, 200);

		if (!name) {
			return fail(400, { error: 'Collection name is required' });
		}

		const slug = slugify(name);
		const existing = await db.select().from(collections).where(eq(collections.slug, slug)).get();
		if (existing) {
			return fail(400, { error: 'A collection with that name already exists' });
		}

		await db.insert(collections).values({ name, slug });
		return { success: true };
	},

	update: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));
		const name = sanitizeText(data.get('name') as string, 200);
		const coverImageUrl = sanitizeUrl(data.get('coverImageUrl') as string);

		if (!id) return fail(400, { error: 'Collection ID is required' });
		if (!name) return fail(400, { error: 'Collection name is required' });

		const slug = slugify(name);

		// Check slug collision with other collections
		const existing = await db.select().from(collections).where(eq(collections.slug, slug)).get();
		if (existing && existing.id !== id) {
			return fail(400, { error: 'A collection with that name already exists' });
		}

		await db
			.update(collections)
			.set({ name, slug, coverImageUrl })
			.where(eq(collections.id, id));

		return { success: true };
	},

	delete: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));

		if (!id) {
			return fail(400, { error: 'Collection ID is required' });
		}

		// Unlink images from this collection
		await db.update(images).set({ collectionId: null }).where(eq(images.collectionId, id));
		await db.delete(collections).where(eq(collections.id, id));
		return { success: true };
	}
} satisfies Actions;
