import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { images, artists, collections, imageTags, tags, characters, imageCharacters } from '$lib/server/db/schema';
import { eq, and, or, asc } from 'drizzle-orm';
import { parseAliases } from '$lib/server/registry';
import { getSettings } from '$lib/server/settings';
import { galleryNeighbors } from '$lib/server/gallery-order';
import { galleryContextFromParams, resolveGallerySort } from '$lib/gallery';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, url }) => {
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
			nsfw: images.nsfw,
			createdAt: images.createdAt,
			commissionedAt: images.commissionedAt
		})
		.from(images)
		.where(
			and(
				or(eq(images.id, groupParentId), eq(images.parentImageId, groupParentId)),
				eq(images.published, true)
			)
		)
		.orderBy(asc(images.id));

	// Previous/next in the order of the grid the visitor came from (SONA-179).
	// The grid's links carry its filters and an explicit sort in the query
	// string; with none, this is the unfiltered gallery in the site's default
	// sort, the same grid /gallery shows. The grid only shows group parents,
	// so a variant pages from its parent's place.
	const context = galleryContextFromParams(url.searchParams);
	const settings = await getSettings(db);
	const sort = resolveGallerySort(context.sort, settings.galleryDefaultSort);
	let anchor = { id: image.id, createdAt: image.createdAt, commissionedAt: image.commissionedAt };
	if (image.parentImageId !== null) {
		const parent = siblings.find((s) => s.id === image.parentImageId);
		if (parent) anchor = { id: parent.id, createdAt: parent.createdAt, commissionedAt: parent.commissionedAt };
	}
	const neighbors = await galleryNeighbors(db, context.filters, sort, anchor);

	return {
		image,
		tags: imageTags_.map((t) => t.name),
		characters: imageChars,
		formerNames,
		// Only meaningful when the group has more than one member.
		// The sort dates were only for the anchor above; the strip doesn't use them.
		variants: siblings.length > 1 ? siblings.map(({ createdAt: _c, commissionedAt: _d, ...v }) => v) : [],
		neighbors,
		// Appended to the previous/next and variant links so the context
		// survives every hop. Empty when the visitor came from no grid.
		contextQuery: context.query
	};
};
