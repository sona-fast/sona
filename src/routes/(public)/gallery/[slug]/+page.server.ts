import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import { images, artists, collections, imageTags, tags, characters, imageCharacters } from '$lib/server/db/schema';
import { eq, and, or, asc } from 'drizzle-orm';
import { parseAliases } from '$lib/server/registry';
import { getSettings } from '$lib/server/settings';
import { collectionNeighbors, galleryNeighbors, type GalleryNeighbors } from '$lib/server/gallery-order';
import { galleryContextFromParams, resolveGallerySort } from '$lib/gallery';
import { withTimeout } from '$lib/server/timeout';
import type { PageServerLoad } from './$types';

// The pager is optional: a slow or failing D1 drops it instead of holding the page.
const NEIGHBORS_TIMEOUT_MS = 2000;

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

	// Tags, characters, and the siblings-then-neighbors chain don't depend on
	// each other, so they run side by side.
	const tagsQuery = db
		.select({ name: tags.name })
		.from(imageTags)
		.innerJoin(tags, eq(imageTags.tagId, tags.id))
		.where(eq(imageTags.imageId, image.id));

	const charactersQuery = db
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
	const siblingsQuery = db
		.select({
			id: images.id,
			slug: images.slug,
			imageUrl: images.imageUrl,
			thumbnailUrl: images.thumbnailUrl,
			variantLabel: images.variantLabel,
			parentImageId: images.parentImageId,
			nsfw: images.nsfw,
			createdAt: images.createdAt,
			commissionedAt: images.commissionedAt,
			collectionId: images.collectionId,
			collectionSlug: collections.slug
		})
		.from(images)
		.leftJoin(collections, eq(images.collectionId, collections.id))
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
	//
	// A collection's links carry ?collection=<slug> instead. The piece then
	// pages through that collection, in the collection page's order, but only
	// when the collection exists and its grid lists this piece (or, for a
	// variant, its parent). Anything else, a forged or stale slug included,
	// falls back to the unfiltered gallery and drops the param from the links,
	// the same way whether the slug names no collection or another one.
	const context = galleryContextFromParams(url.searchParams);
	const siblingsAndNeighbors = (async () => {
		const siblings = await siblingsQuery;
		// The grid piece this page pages from: the image itself, or for a
		// variant its published parent. A variant whose parent is unpublished
		// has no card in any grid: it keeps its own row and never pages a
		// collection.
		const parent = image.parentImageId === null ? undefined : siblings.find((s) => s.id === image.parentImageId);
		const anchorIsCard = image.parentImageId === null || parent !== undefined;
		const { id, createdAt, commissionedAt, collectionId, collectionSlug } = parent ?? image;
		const anchor = { id, createdAt, commissionedAt };
		// The anchor's collection came back with its row, so membership needs
		// no lookup of its own, and is settled before the neighbor walk starts.
		const inCollection =
			context.collection !== null && anchorIsCard && collectionId !== null && collectionSlug === context.collection;
		// The links keep a gallery context, or a confirmed collection, and
		// drop an unconfirmed collection slug.
		const keptQuery = context.collection === null || inCollection ? context.query : '';
		const paging = await withTimeout(
			(async (): Promise<{ neighbors: GalleryNeighbors; contextQuery: string }> => {
				if (inCollection && collectionId !== null) {
					return {
						neighbors: await collectionNeighbors(db, collectionId, anchor),
						contextQuery: keptQuery
					};
				}
				// A collection context carries no gallery filters or sort, so a
				// fallback from one lands on the unfiltered gallery.
				const settings = await getSettings(db);
				const sort = resolveGallerySort(context.sort, settings.galleryDefaultSort);
				return {
					neighbors: await galleryNeighbors(db, context.filters, sort, anchor),
					contextQuery: keptQuery
				};
			})(),
			NEIGHBORS_TIMEOUT_MS,
			// A slow walk drops the pager, but not a context that held.
			{ neighbors: { prev: null, next: null }, contextQuery: keptQuery }
		);
		return { siblings, ...paging };
	})();

	const [imageTags_, imageChars, { siblings, neighbors, contextQuery }] = await Promise.all([
		tagsQuery,
		charactersQuery,
		siblingsAndNeighbors
	]);

	return {
		image,
		tags: imageTags_.map((t) => t.name),
		characters: imageChars,
		formerNames,
		// Only meaningful when the group has more than one member.
		// The sort dates and collection were only for the anchor above; the strip doesn't use them.
		variants:
			siblings.length > 1
				? siblings.map(({ createdAt: _c, commissionedAt: _d, collectionId: _e, collectionSlug: _f, ...v }) => v)
				: [],
		neighbors,
		// Appended to the previous/next and variant links so the context
		// survives every hop. Empty when the visitor came from no grid, or from
		// a collection this piece isn't in.
		contextQuery
	};
};
