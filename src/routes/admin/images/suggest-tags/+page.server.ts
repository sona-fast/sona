import { fail } from '@sveltejs/kit';
import { and, desc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { artists, imageTags, images } from '$lib/server/db/schema';
import { replaceImageTags } from '$lib/server/image-tags';
import { classifySourceUrl } from '$lib/tags';
import type { Actions, PageServerLoad } from './$types';

// The backfill list behind /admin/images/suggest-tags (SONA-220): every image
// that already carries a Bluesky or X source post but has no tags yet.
//
// SQLite cannot tell a Bluesky post URL from any other link, so the query
// narrows to rows that have SOME source URL and no tag rows, and
// classifySourceUrl — the recogniser the endpoint and the pill also use —
// decides which of those belong on the page. The candidate set is small on a
// personal gallery (an image either has tags or it does not), so it is
// classified whole: that is what lets the page say "Showing 4 of 12" honestly.

// SvelteKit rejects any other named export from a +page.server file unless it
// starts with an underscore; the tests read these under these names.
const PER_PAGE = 20;
export { PER_PAGE as _PER_PAGE };

/** Ceiling on how many candidate rows one load will classify. A library where
 * nothing has been tagged yet would otherwise walk the whole table on every
 * page view. Past this the page shows what it found, and the total it reports
 * is capped at the scan limit rather than the true count. */
const MAX_SCAN = 2000;

export type SuggestRow = {
	id: number;
	title: string;
	thumbnailUrl: string | null;
	imageUrl: string;
	artistName: string | null;
	source: 'bluesky' | 'x';
};

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDb(platform!.env.DB);
	// "Load more" grows the page rather than paging away from it, so the rows the
	// operator has already worked through stay where they were. A hand-edited
	// query string is not an error page: anything that is not a whole number
	// above zero reads as the first page. (Math.max alone would let NaN through
	// and slice the list down to nothing.)
	const asked = Math.floor(Number(url.searchParams.get('pages') || 1));
	const pages = Number.isFinite(asked) ? Math.max(1, asked) : 1;
	const want = pages * PER_PAGE;

	// Images with at least one tag row; everything else is a candidate.
	const tagged = db.select({ id: imageTags.imageId }).from(imageTags);

	const candidates = await db
		.select({
			id: images.id,
			title: images.title,
			thumbnailUrl: images.thumbnailUrl,
			imageUrl: images.imageUrl,
			artistName: artists.name,
			sourcePostUrl: images.sourcePostUrl
		})
		.from(images)
		.leftJoin(artists, eq(images.artistId, artists.id))
		.where(
			and(
				isNotNull(images.sourcePostUrl),
				sql`${images.sourcePostUrl} <> ''`,
				notInArray(images.id, tagged)
			)
		)
		.orderBy(desc(images.id))
		.limit(MAX_SCAN);

	const matches: SuggestRow[] = [];
	for (const row of candidates) {
		const source = classifySourceUrl(row.sourcePostUrl ?? '');
		if (!source) continue;
		matches.push({
			id: row.id,
			title: row.title,
			thumbnailUrl: row.thumbnailUrl,
			imageUrl: row.imageUrl,
			artistName: row.artistName,
			source: source.kind
		});
	}

	return { rows: matches.slice(0, want), total: matches.length, pages };
};

export const actions: Actions = {
	// Accepting a row's chips writes that image's tags immediately — there is no
	// form Save on this page. The two forms stage tags; this page commits them.
	save: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'invalid_request' });

		const row = await db.select({ id: images.id }).from(images).where(eq(images.id, id)).get();
		if (!row) return fail(404, { error: 'not_found' });

		// The row was listed because it had no tags, but the edit form or another
		// tab may have tagged it since the list loaded. replaceImageTags deletes
		// before it inserts, so writing now would throw those tags away: refuse,
		// and let the row send the operator to the edit form instead.
		const tagged = await db
			.select({ tagId: imageTags.tagId })
			.from(imageTags)
			.where(eq(imageTags.imageId, id))
			.limit(1)
			.get();
		if (tagged) return fail(409, { error: 'tagged_elsewhere' });

		// The same persistence the edit form's save uses, so a tag written here is
		// indistinguishable from one typed there.
		const written = await replaceImageTags(db, id, String(data.get('tags') ?? ''));
		return { savedId: id, savedTags: written };
	}
};
