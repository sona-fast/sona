import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { tags, imageTags } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { sanitizeTag } from '$lib/server/validate';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDb(platform!.env.DB);

	const page = Math.max(1, Number(url.searchParams.get('page') || 1));
	const perPage = 25;

	const totalResult = await db
		.select({ count: sql<number>`COUNT(*)` })
		.from(tags)
		.get();
	const total = totalResult?.count || 0;

	const allTags = await db
		.select({
			id: tags.id,
			name: tags.name,
			createdAt: tags.createdAt,
			usageCount: sql<number>`(SELECT COUNT(*) FROM image_tags WHERE image_tags.tag_id = tags.id)`
		})
		.from(tags)
		.orderBy(tags.name)
		.limit(perPage)
		.offset((page - 1) * perPage);

	return { tags: allTags, page, total, totalPages: Math.ceil(total / perPage) };
};

export const actions = {
	create: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const name = sanitizeTag(data.get('name') as string);

		if (!name) {
			return fail(400, { error: 'Tag name is required' });
		}

		const existing = await db.select().from(tags).where(eq(tags.name, name)).get();
		if (existing) {
			return fail(400, { error: 'Tag already exists' });
		}

		await db.insert(tags).values({ name });
		return { success: true };
	},

	delete: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));

		if (!id) {
			return fail(400, { error: 'Tag ID is required' });
		}

		await db.delete(imageTags).where(eq(imageTags.tagId, id));
		await db.delete(tags).where(eq(tags.id, id));
		return { success: true };
	}
} satisfies Actions;
