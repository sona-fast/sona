import { getDb } from '$lib/server/db';
import { images, artists, imageTags, tags } from '$lib/server/db/schema';
import { getSettings, parseSonaColors, parseLines } from '$lib/server/settings';
import { and, desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

// The reference sheet is the most recent published gallery image tagged this.
const REFERENCE_TAG = 'reference';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db);

	const refSheet =
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
