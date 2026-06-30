import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { images, artists, collections, tags, imageTags, characters, imageCharacters } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { resolveAvatarUrl } from '$lib/server/avatar';
import { sanitizeText, sanitizeUrl, sanitizeTag } from '$lib/server/validate';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform }) => {
	const db = getDb(platform!.env.DB);
	const id = Number(params.id);

	const image = await db
		.select()
		.from(images)
		.where(eq(images.id, id))
		.get();

	if (!image) error(404, 'Image not found');

	const imageTagRows = await db
		.select({ name: tags.name })
		.from(imageTags)
		.innerJoin(tags, eq(imageTags.tagId, tags.id))
		.where(eq(imageTags.imageId, id));

	const imageCharacterRows = await db
		.select({ id: characters.id })
		.from(imageCharacters)
		.innerJoin(characters, eq(imageCharacters.characterId, characters.id))
		.where(eq(imageCharacters.imageId, id));

	const [allArtists, allCollections, allTags, allCharacters] = await Promise.all([
		db.select().from(artists).orderBy(artists.name),
		db.select().from(collections).orderBy(collections.name),
		db.select().from(tags).orderBy(tags.name),
		db.select().from(characters).orderBy(characters.name)
	]);

	return {
		image,
		imageTags: imageTagRows.map((t) => t.name),
		imageCharacterIds: imageCharacterRows.map((c) => c.id),
		artists: allArtists,
		collections: allCollections,
		tags: allTags,
		characters: allCharacters
	};
};

export const actions = {
	default: async ({ params, request, platform }) => {
		const db = getDb(platform!.env.DB);
		const id = Number(params.id);
		const data = await request.formData();

		const title = sanitizeText(data.get('title') as string, 200);
		const artistId = data.get('artistId') as string;
		const artistName = sanitizeText(data.get('artistName') as string, 200);
		const collectionId = data.get('collectionId') as string;
		const tagNames = sanitizeText(data.get('tags') as string, 500);
		const characterIds = (data.get('characters') as string)?.trim();
		const nsfw = data.get('nsfw') === 'on';
		const published = data.get('published') !== 'on';
		const sourcePostUrl = sanitizeUrl(data.get('sourcePostUrl') as string);
		const commissionedAt = (data.get('commissionedAt') as string)?.trim();

		// Artist social links (for new artists)
		const twitterUrl = sanitizeUrl(data.get('twitter') as string);
		const blueskyUrl = sanitizeUrl(data.get('bluesky') as string);
		const telegramUrl = sanitizeUrl(data.get('telegram') as string);
		const furAffinityUrl = sanitizeUrl(data.get('furaffinity') as string);
		const deviantArtUrl = sanitizeUrl(data.get('deviantart') as string);
		const patreonUrl = sanitizeUrl(data.get('patreon') as string);
		const instagramUrl = sanitizeUrl(data.get('instagram') as string);

		if (!title) return fail(400, { error: 'Title is required' });

		// Resolve or create artist
		let resolvedArtistId: number;
		if (artistId && artistId !== 'new') {
			resolvedArtistId = Number(artistId);
		} else if (artistName) {
			const avatarUrl = await resolveAvatarUrl({ blueskyUrl, twitterUrl, furAffinityUrl, patreonUrl });
			const newArtist = await db
				.insert(artists)
				.values({
					name: artistName,
					avatarUrl,
					twitterUrl,
					blueskyUrl,
					telegramUrl,
					furAffinityUrl,
					deviantArtUrl,
					patreonUrl,
					instagramUrl
				})
				.returning({ id: artists.id })
				.get();
			resolvedArtistId = newArtist.id;
		} else {
			return fail(400, { error: 'Artist is required' });
		}

		// Update image
		await db
			.update(images)
			.set({
				title,
				artistId: resolvedArtistId,
				collectionId: collectionId ? Number(collectionId) : null,
				nsfw,
				published,
				sourcePostUrl: sourcePostUrl || null,
				commissionedAt: commissionedAt || null
			})
			.where(eq(images.id, id));

		// Update tags: remove old, add new
		await db.delete(imageTags).where(eq(imageTags.imageId, id));

		if (tagNames) {
			const tagList = tagNames.split(',').map(sanitizeTag).filter(Boolean);
			for (const tagName of tagList) {
				let tag = await db.select().from(tags).where(eq(tags.name, tagName)).get();
				if (!tag) {
					tag = await db.insert(tags).values({ name: tagName }).returning().get();
				}
				await db.insert(imageTags).values({ imageId: id, tagId: tag.id });
			}
		}

		// Update characters: remove old, add new
		await db.delete(imageCharacters).where(eq(imageCharacters.imageId, id));

		if (characterIds) {
			const ids = characterIds.split(',').map((cid) => Number(cid.trim())).filter(Boolean);
			for (const charId of ids) {
				await db.insert(imageCharacters).values({ imageId: id, characterId: charId });
			}
		}

		redirect(302, '/admin/images');
	}
} satisfies Actions;
