import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { artists, collections, tags, images, imageTags, characters, imageCharacters } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { slugify } from '$lib/server/slugify';
import { sanitizeText, sanitizeUrl, sanitizeTag } from '$lib/server/validate';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);

	const [allArtists, allCollections, allTags, allCharacters] = await Promise.all([
		db.select().from(artists).orderBy(artists.name),
		db.select().from(collections).orderBy(collections.name),
		db.select().from(tags).orderBy(tags.name),
		db.select().from(characters).orderBy(characters.name)
	]);

	return {
		artists: allArtists,
		collections: allCollections,
		tags: allTags,
		characters: allCharacters
	};
};

export const actions = {
	default: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();

		const title = sanitizeText(data.get('title') as string, 200);
		const imageUrl = sanitizeUrl(data.get('imageUrl') as string);
		const width = Number(data.get('width')) || null;
		const height = Number(data.get('height')) || null;
		const fileSize = Number(data.get('fileSize')) || null;
		const artistId = data.get('artistId') as string;
		const collectionId = data.get('collectionId') as string;
		const tagNames = sanitizeText(data.get('tags') as string, 500);
		const characterIds = (data.get('characters') as string)?.trim();
		const nsfw = data.get('nsfw') === 'on';
		const published = data.get('published') !== 'on';
		const sourcePostUrl = sanitizeUrl(data.get('sourcePostUrl') as string);
		const commissionedAt = (data.get('commissionedAt') as string)?.trim();

		if (!title) return fail(400, { error: 'Title is required' });
		if (!imageUrl) return fail(400, { error: 'Image URL is required' });

		// The New Artist dialog creates the artist up front (via /api/artists), so
		// the form always submits an existing artist id.
		const resolvedArtistId = Number(artistId);
		if (!resolvedArtistId) return fail(400, { error: 'Artist is required' });

		const slug = slugify(title);

		// Insert image
		const newImage = await db
			.insert(images)
			.values({
				title,
				slug,
				imageUrl,
				width,
				height,
				fileSize,
				artistId: resolvedArtistId,
				collectionId: collectionId ? Number(collectionId) : null,
				nsfw,
				published,
				sourcePostUrl: sourcePostUrl || null,
				commissionedAt: commissionedAt || null
			})
			.returning({ id: images.id })
			.get();

		// Handle tags
		if (tagNames) {
			const tagList = tagNames.split(',').map(sanitizeTag).filter(Boolean);
			for (const tagName of tagList) {
				let tag = await db.select().from(tags).where(eq(tags.name, tagName)).get();
				if (!tag) {
					tag = await db.insert(tags).values({ name: tagName }).returning().get();
				}
				await db.insert(imageTags).values({ imageId: newImage.id, tagId: tag.id });
			}
		}

		// Handle characters
		if (characterIds) {
			const ids = characterIds.split(',').map((id) => Number(id.trim())).filter(Boolean);
			for (const charId of ids) {
				await db.insert(imageCharacters).values({ imageId: newImage.id, characterId: charId });
			}
		}

		redirect(302, '/admin/images');
	}
} satisfies Actions;
