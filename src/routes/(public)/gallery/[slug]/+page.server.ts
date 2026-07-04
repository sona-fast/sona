import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { images, artists, collections, imageTags, tags, characters, imageCharacters } from '$lib/server/db/schema';
import { eq, and, or, asc } from 'drizzle-orm';
import { parseAliases } from '$lib/server/registry';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform }) => {
	// read replica (eventually consistent); admin writes use the primary
	const db = getReadDb(platform!.env.DB);

	const image = await db
		.select({
			id: images.id,
			title: images.title,
			slug: images.slug,
			imageUrl: images.imageUrl,
			width: images.width,
			height: images.height,
			fileSize: images.fileSize,
			nsfw: images.nsfw,
			sourcePostUrl: images.sourcePostUrl,
			commissionedAt: images.commissionedAt,
			createdAt: images.createdAt,
			artistId: images.artistId,
			artistName: artists.name,
			artistAvatar: artists.avatarUrl,
			artistTwitter: artists.twitterUrl,
			artistBluesky: artists.blueskyUrl,
			artistTelegram: artists.telegramUrl,
			artistFurAffinity: artists.furAffinityUrl,
			artistDeviantArt: artists.deviantArtUrl,
			artistPatreon: artists.patreonUrl,
			artistInstagram: artists.instagramUrl,
			artistAliases: artists.aliases,
			collectionId: images.collectionId,
			collectionName: collections.name,
			collectionSlug: collections.slug,
			parentImageId: images.parentImageId,
			variantLabel: images.variantLabel
		})
		.from(images)
		.leftJoin(artists, eq(images.artistId, artists.id))
		.leftJoin(collections, eq(images.collectionId, collections.id))
		.where(and(eq(images.slug, params.slug), eq(images.published, true)))
		.get();

	if (!image) {
		error(404, 'Image not found');
	}

	const imageTags_ = await db
		.select({ name: tags.name })
		.from(imageTags)
		.innerJoin(tags, eq(imageTags.tagId, tags.id))
		.where(eq(imageTags.imageId, image.id));

	const imageChars = await db
		.select({
			name: characters.name,
			ownerName: characters.ownerName,
			url: characters.url,
			twitterUrl: characters.twitterUrl,
			blueskyUrl: characters.blueskyUrl,
			telegramUrl: characters.telegramUrl,
			furAffinityUrl: characters.furAffinityUrl,
			deviantArtUrl: characters.deviantArtUrl,
			patreonUrl: characters.patreonUrl,
			instagramUrl: characters.instagramUrl,
			avatarUrl: characters.avatarUrl
		})
		.from(imageCharacters)
		.innerJoin(characters, eq(imageCharacters.characterId, characters.id))
		.where(eq(imageCharacters.imageId, image.id));

	// Former artist names ("also known as") for the quiet "// formerly" credit line.
	const formerNames = parseAliases(image.artistAliases).map((a) => a.displayName);

	// Variant strip: the parent + all of its (published) variants, in id order.
	// Direct links to a variant's slug resolve like any image, so the strip is
	// anchored on whichever group this image belongs to.
	const groupParentId = image.parentImageId ?? image.id;
	const siblings = await db
		.select({
			id: images.id,
			slug: images.slug,
			imageUrl: images.imageUrl,
			thumbnailUrl: images.thumbnailUrl,
			variantLabel: images.variantLabel,
			parentImageId: images.parentImageId,
			nsfw: images.nsfw
		})
		.from(images)
		.where(
			and(
				or(eq(images.id, groupParentId), eq(images.parentImageId, groupParentId)),
				eq(images.published, true)
			)
		)
		.orderBy(asc(images.id));

	return {
		image,
		tags: imageTags_.map((t) => t.name),
		characters: imageChars,
		formerNames,
		// Only meaningful when the group has more than one member.
		variants: siblings.length > 1 ? siblings : []
	};
};
