import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { images, artists, imageTags, tags, characters } from '$lib/server/db/schema';
import { getSettings } from '$lib/server/settings';
import { REFERENCE_TAG, sonaDetails, artHasContent } from '$lib/server/presence';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db);

	// refSheet precedence: an owner character's explicit reference_image_id wins
	// (when that image is published); otherwise fall back to the most recent
	// published image tagged REFERENCE_TAG.
	const owner = await db
		.select({ referenceImageId: characters.referenceImageId })
		.from(characters)
		.where(eq(characters.isOwner, true))
		// first owner by name — must match the loads' find() over name-ordered characters
		.orderBy(characters.name)
		.get();

	let refSheet =
		owner?.referenceImageId != null
			? (await db
					.select({
						slug: images.slug,
						imageUrl: images.imageUrl,
						title: images.title,
						artistName: artists.name,
						// width/height reserve the img box (no CLS) — the ref sheet is the
						// page's LCP element.
						width: images.width,
						height: images.height
					})
					.from(images)
					.leftJoin(artists, eq(artists.id, images.artistId))
					.where(and(eq(images.id, owner.referenceImageId), eq(images.published, true)))
					.get()) ?? null
			: null;

	refSheet ??=
		(await db
			.select({
				slug: images.slug,
				imageUrl: images.imageUrl,
				title: images.title,
				artistName: artists.name,
				width: images.width,
				height: images.height
			})
			.from(images)
			.innerJoin(imageTags, eq(imageTags.imageId, images.id))
			.innerJoin(tags, eq(tags.id, imageTags.tagId))
			.leftJoin(artists, eq(artists.id, images.artistId))
			.where(and(eq(tags.name, REFERENCE_TAG), eq(images.published, true)))
			.orderBy(desc(images.createdAt))
			.get()) ?? null;

	const recentArt = await db
		.select({ slug: images.slug, imageUrl: images.imageUrl, thumbnailUrl: images.thumbnailUrl, title: images.title })
		.from(images)
		.where(and(eq(images.published, true), eq(images.nsfw, false)))
		.orderBy(desc(images.createdAt))
		.limit(3);

	// Operator-curated Featured section (#58). Ordered by featuredOrder ASC NULLS
	// LAST, then createdAt DESC — the first row is the hero, the next up to 4 are
	// the supporting row, so cap at 5.
	const featuredArt = await db
		.select({ slug: images.slug, imageUrl: images.imageUrl, thumbnailUrl: images.thumbnailUrl, title: images.title, artistName: artists.name })
		.from(images)
		.leftJoin(artists, eq(artists.id, images.artistId))
		.where(and(eq(images.published, true), eq(images.nsfw, false), eq(images.featured, true)))
		// id DESC is the final tiebreaker so order is deterministic when featuredOrder
		// AND createdAt collide.
		.orderBy(sql`${images.featuredOrder} asc nulls last`, desc(images.createdAt), desc(images.id))
		.limit(5);

	const sona = sonaDetails(settings);

	// Content-presence gate (#42): 404 only when every content source this page
	// renders is absent (see artHasContent, a pure predicate over the rows this
	// load already fetched — no extra queries). Any single source keeps the page
	// URL-reachable (deep-link use case: mosaic forks sharing their ref sheet).
	if (!artHasContent(sona, refSheet, recentArt)) error(404, 'Not found');

	return { refSheet, recentArt, featuredArt, sona };
};
