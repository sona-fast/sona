import { fail } from '@sveltejs/kit';
import { and, desc, eq, inArray, like, notInArray, or } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { artists, imageTags, images } from '$lib/server/db/schema';
import { parseImageTags, readTagInput, replaceImageTags } from '$lib/server/image-tags';
import { classifySourceUrl, SOURCE_POST_HOSTS } from '$lib/tags';
import type { Actions, PageServerLoad } from './$types';

// The backfill list behind /admin/images/suggest-tags (SONA-220): every image
// that already carries a Bluesky or X source post but has no tags yet.
//
// SQLite cannot parse a URL, but it can match one's scheme and host, so the
// query narrows to untagged rows whose source URL starts with a host
// classifySourceUrl knows — and classifySourceUrl, the recogniser the endpoint
// and the pill also use, is still what decides whether a fetched row belongs on
// the page. Filtering in SQL rather than after the scan is what keeps the cap
// honest: the newest 2,000 untagged images can all be FurAffinity links, and
// the page would have reported no work left while Bluesky rows sat below them.
// The candidate set is small on a personal gallery (an image either has tags or
// it does not), so it is classified whole: that is what lets the page say
// "Showing 4 of 12" honestly.

// SvelteKit rejects any other named export from a +page.server file unless it
// starts with an underscore; the tests read these under these names.
const PER_PAGE = 20;
export { PER_PAGE as _PER_PAGE };

/** Ceiling on how many candidate rows one load will classify. A library where
 * nothing has been tagged yet would otherwise walk the whole table on every
 * page view. Past this the page shows what it found, and the total it reports
 * is capped at the scan limit rather than the true count. */
const MAX_SCAN = 2000;
export { MAX_SCAN as _MAX_SCAN };

/** How many ids one display query binds. D1 allows 100 bound parameters. */
const ID_CHUNK = 90;

/** The scan's "this link could be a post we understand" test, in SQL.
 *
 * One LIKE per scheme and host, with and without `www.`, because that is the
 * part of a URL SQLite can match without parsing it. SQLite's LIKE is
 * case-insensitive over ASCII, so a stored URL that shouts its host still
 * matches. The patterns are deliberately the plain forms an operator pastes or
 * an importer stores; an exotic equivalent (a port, say) is not scanned, and
 * that image is still taggable from its own edit page. */
const SUPPORTED_SOURCE = or(
	...SOURCE_POST_HOSTS.flatMap((host) =>
		['https://', 'http://'].flatMap((scheme) => [
			like(images.sourcePostUrl, `${scheme}${host}/%`),
			like(images.sourcePostUrl, `${scheme}www.${host}/%`)
		])
	)
);

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
	// Clamped above as well: the scan stops at MAX_SCAN, so more pages than that
	// covers can only inflate the Load more link's next number without adding a
	// row.
	const asked = Math.floor(Number(url.searchParams.get('pages') || 1));
	const pages = Number.isFinite(asked)
		? Math.min(Math.max(1, asked), Math.ceil(MAX_SCAN / PER_PAGE))
		: 1;
	const want = pages * PER_PAGE;

	// Images with at least one tag row; everything else is a candidate.
	const tagged = db.select({ id: imageTags.imageId }).from(imageTags);

	// The scan reads only what decides membership: the id and the URL the
	// classifier judges. Carrying the display columns through it would put up to
	// MAX_SCAN titles, thumbnails and image URLs in one D1 response — hundreds of
	// kilobytes against a 1 MB cap — to render twenty of them.
	const candidates = await db
		.select({ id: images.id, sourcePostUrl: images.sourcePostUrl })
		.from(images)
		// A URL on a supported host is never null and never empty, so this one
		// condition carries what two used to.
		.where(and(SUPPORTED_SOURCE, notInArray(images.id, tagged)))
		.orderBy(desc(images.id))
		.limit(MAX_SCAN);

	const matches: { id: number; source: 'bluesky' | 'x' }[] = [];
	for (const row of candidates) {
		const source = classifySourceUrl(row.sourcePostUrl ?? '');
		if (source) matches.push({ id: row.id, source: source.kind });
	}

	const shown = matches.slice(0, want);
	// D1 takes at most 100 bound parameters in one query, and "Load more" grows
	// the page past that, so the display fetch goes in chunks.
	// The chunks are issued together rather than one after the other: they are
	// independent reads, and the page's own order comes from `shown` below.
	const chunks = [];
	for (let from = 0; from < shown.length; from += ID_CHUNK) {
		const ids = shown.slice(from, from + ID_CHUNK).map((row) => row.id);
		chunks.push(
			db
				.select({
					id: images.id,
					title: images.title,
					thumbnailUrl: images.thumbnailUrl,
					imageUrl: images.imageUrl,
					artistName: artists.name
				})
				.from(images)
				.leftJoin(artists, eq(images.artistId, artists.id))
				.where(inArray(images.id, ids))
		);
	}
	const details = new Map<number, Omit<SuggestRow, 'source'>>();
	for (const rows of await Promise.all(chunks)) {
		for (const row of rows) details.set(row.id, row);
	}

	// Ordered by `shown`, not by the fetch: the display query says nothing about
	// order, and the list is newest first.
	const rows = shown.flatMap(({ id, source }) => {
		const detail = details.get(id);
		return detail ? [{ ...detail, source }] : [];
	});

	return { rows, total: matches.length, pages };
};

export const actions: Actions = {
	// Accepting a row's chips writes that image's tags immediately — there is no
	// form Save on this page. The two forms stage tags; this page commits them.
	save: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'invalid_request' });

		// These tags come from the tray rather than a text field, so reaching the
		// cap here takes a hand-made post. The three write paths read the field
		// through the same helper, and refuse rather than truncate. This page has no
		// field to word two refusals for, so both problems answer the same way.
		const tags = readTagInput(String(data.get('tags') ?? ''));
		if (tags.problem) return fail(400, { error: 'too_many_tags' });
		const tagNames = tags.value;
		// The tray refuses a save with nothing picked, so an empty list only reaches
		// here from a hand-made post or a form submitted before the page hydrated.
		// Refusing matches what the tray does: a save that stores nothing should not
		// report a success the row would then show as "Saved 0 tags".
		if (parseImageTags(tagNames).length === 0) return fail(400, { error: 'invalid_request' });

		const row = await db.select({ id: images.id }).from(images).where(eq(images.id, id)).get();
		if (!row) return fail(404, { error: 'not_found' });

		// The row was listed because it had no tags, but the edit form or another
		// tab may have tagged it since the list loaded. Writing now would throw
		// those tags away: refuse, and let the row send the operator to the edit
		// form instead. This look is the fast path — it answers the common case
		// without attempting a write — but it is not what makes the refusal safe;
		// the write carries the same condition (see below).
		const tagged = await db
			.select({ tagId: imageTags.tagId })
			.from(imageTags)
			.where(eq(imageTags.imageId, id))
			.limit(1)
			.get();
		if (tagged) return fail(409, { error: 'tagged_elsewhere' });

		// The same persistence the edit form's save uses, so a tag written here is
		// indistinguishable from one typed there — plus the still-untagged
		// condition, evaluated inside the write itself. A tab that tags the image
		// in the gap after the look above loses no work: the write does nothing and
		// reports the conflict the operator would have got a moment earlier.
		const { written, skipped } = await replaceImageTags(db, id, tagNames, {
			requireUntagged: true
		});
		if (skipped) return fail(409, { error: 'tagged_elsewhere' });
		// The count above said there was something to write, so an empty answer
		// means every name fell away inside the write — a tag row deleted between
		// the conflict and the re-select. Reporting success would render "Saved 0
		// tags" over an empty chip row; the row shows the save failed instead, with
		// its chips still there to try again.
		if (written.length === 0) return fail(500, { error: 'save_failed' });
		return { savedId: id, savedTags: written };
	}
};
