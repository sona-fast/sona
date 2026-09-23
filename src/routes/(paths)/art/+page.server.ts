import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { images, artists } from '$lib/server/db/schema';
import { getSettings } from '$lib/server/settings';
import { sonaDetails, artHasContent, loadRefSheet } from '$lib/server/presence';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db);

	// The ref sheet precedence lives in loadRefSheet, shared with the passport
	// homepage so the two pages can never pick different pictures. It honors an
	// NSFW designation (SONA-18); the page renders it behind the blur shield.
	// (The recentArt strip below still lists variants as standalone cards,
	// unlike the gallery and homepage queries — an older inconsistency this
	// change doesn't touch.)
	const refSheet = await loadRefSheet(db);

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
