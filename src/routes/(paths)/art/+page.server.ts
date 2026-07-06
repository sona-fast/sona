import { getDb } from '$lib/server/db';
import { images, artists, imageTags, tags, characters } from '$lib/server/db/schema';
import { getSettings, parseSonaColors, parseLines } from '$lib/server/settings';
import { and, desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

// The reference sheet is the most recent published gallery image tagged this.
const REFERENCE_TAG = 'reference';

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
						artistName: artists.name
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
				artistName: artists.name
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

	return {
		refSheet,
		recentArt,
		sona: {
			species: settings.sonaSpecies,
			build: settings.sonaBuild,
			keyFeatures: settings.sonaKeyFeatures,
			colors: parseSonaColors(settings.sonaColors),
			dos: parseLines(settings.sonaDos),
			donts: parseLines(settings.sonaDonts)
		}
	};
};
