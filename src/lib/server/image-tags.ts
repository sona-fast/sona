import { eq, sql } from 'drizzle-orm';
import { getDb } from './db';
import { imageTags, tags } from './db/schema';
import { sanitizeText } from './validate';
import { sanitizeTag, TAG_MAX_LENGTH } from '$lib/tags';

type Db = ReturnType<typeof getDb>;

/** Ceiling on how many tags one save keeps, counted after sanitizing and
 * de-duplicating. The edit form and the Suggest tags page both write through
 * here, so this is the one place the two save paths agree on a limit. */
export const MAX_IMAGE_TAGS = 100;

/** Ceiling on the raw Tags field, in characters. Derived from the other two caps
 * rather than picked, so an input the count guard would accept is never refused
 * or cut first: MAX_IMAGE_TAGS names at the longest a name may be, plus the two
 * characters of ", " each one is separated by. At a flat 4000 a legal 100 tags of
 * 50 characters came to 5,198 and was refused as too long, which named the wrong
 * problem. Past this the save actions refuse rather than truncate: a field
 * truncated mid-name stores the fragment and reports success, which is the
 * failure the count guard exists to prevent. */
export const MAX_TAGS_INPUT_LENGTH = MAX_IMAGE_TAGS * (TAG_MAX_LENGTH + 2);

/**
 * The tag names a comma-separated input really holds: sanitized, blanks dropped,
 * repeats collapsed. The save actions count these to refuse an over-cap input
 * before they write anything, so what they count is what would land.
 */
export function parseImageTags(tagNames: string): string[] {
	const names: string[] = [];
	for (const name of tagNames.split(',').map(sanitizeTag)) {
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * Read a Tags field the way all three save actions have to read it: the length
 * check runs on the raw value, because sanitizing shortens it and a field cut
 * to the ceiling would pass a check the operator's input failed; the count runs
 * on the sanitized value, because that is what would be written.
 *
 * Returns the sanitized value only when there is no problem, so a caller that
 * accepts the input writes the same string this counted and one that forwards
 * the value without checking cannot exist: a refused field has no value to
 * write, and writing the empty string it used to carry would clear every tag on
 * the image. The three actions word their refusals differently, so the problem
 * is named rather than phrased here.
 */
export function readTagInput(
	raw: string
): { problem: 'too_long' } | { problem: 'too_many' } | { problem: null; value: string } {
	if (raw.length > MAX_TAGS_INPUT_LENGTH) return { problem: 'too_long' };
	const value = sanitizeText(raw, MAX_TAGS_INPUT_LENGTH);
	if (parseImageTags(value).length > MAX_IMAGE_TAGS) return { problem: 'too_many' };
	return { problem: null, value };
}

/** How many associations one insert statement carries. D1 allows 100 bound
 * parameters per statement and each row binds two, so a hundred-tag save goes
 * in as several statements inside the one batch rather than a single insert
 * that D1 would refuse. */
const ASSOCIATION_CHUNK = 45;

/** What a tag write did: the names that landed, and whether the write was
 * refused because the image had gained tags since the caller looked. `skipped`
 * is only ever true for a `requireUntagged` write. */
export type ImageTagWrite = { written: string[]; skipped: boolean };

/**
 * Replace an image's tags with the ones in a comma-separated string, minting
 * any tag row that does not exist yet.
 *
 * Extracted from the edit form's save action (SONA-220) so the Suggest tags
 * page writes tags the same way the form does: same sanitizer, same
 * delete-then-insert, same tag table. Returns the tag names actually written,
 * so a caller can say how many landed.
 *
 * The delete and the association inserts go in one D1 batch, which commits as a
 * single transaction: a failure part-way through leaves the image's previous
 * tags where they were rather than dropping them and saving some of the new set.
 *
 * With `requireUntagged`, the write only happens if the image still has no tag
 * rows when it runs — the precondition the backfill page needs, checked inside
 * the write instead of before it, so a tab that tagged the image meanwhile gets
 * a conflict rather than having its work deleted. The answer carries
 * `skipped: true` when that guard refused the write.
 */
export async function replaceImageTags(
	db: Db,
	imageId: number,
	tagNames: string,
	options: { requireUntagged?: boolean } = {}
): Promise<ImageTagWrite> {
	// An empty field still deletes: clearing the Tags box on the edit form is how
	// an image loses its tags. A caller with nothing to delete — a just-inserted
	// image — skips this function instead. A `requireUntagged` caller has nothing
	// to write, so it has nothing to delete either.
	//
	// A field that holds no usable name says the same thing as an empty one: a
	// Tags box of "🦊" or "!!!" sanitizes away to nothing, and the operator who
	// typed it over the image's tags asked for those tags to go. Read here rather
	// than in the loop below so that case cannot be mistaken for the very
	// different one further down, where names parsed fine and then fell away
	// while they were being minted.
	const names = parseImageTags(tagNames);
	if (names.length === 0) {
		if (!options.requireUntagged) {
			await db.delete(imageTags).where(eq(imageTags.imageId, imageId));
		}
		return { written: [], skipped: false };
	}

	// Tag rows are shared between images, so minting them stays outside the batch:
	// a name another save minted first is one this save links to, not one it has
	// to undo.
	//
	// Which means a write that does not go through — the `requireUntagged` guard
	// refusing, or the batch below failing — leaves the names it minted in the tag
	// table with nothing pointing at them, and /admin/tags lists them as zero-use
	// names. That is accepted rather than cleaned up: a tag row is shared and
	// carries nothing of its own, the operator can remove it from /admin/tags, and
	// deleting it here would race the save that read it a moment ago and is about
	// to link it — which would leave a real association pointing at a row that is
	// gone. An unused name is the cheaper of the two.
	const written: string[] = [];
	const tagIds: number[] = [];
	for (const tagName of names) {
		// The actions refuse an over-cap input before they write; this is the net
		// under anything that reaches here by another path.
		if (written.length >= MAX_IMAGE_TAGS) break;
		let tag = await db.select().from(tags).where(eq(tags.name, tagName)).get();
		if (!tag) {
			// `tags.name` is unique, and two saves can run at once: the backfill page
			// guards saving per row, and two untagged images by one artist carry the
			// same names, so both requests can see no `fox` row and both insert. A
			// plain insert throws on the second, the action answers with an error,
			// and the page renders it over the list — losing every other row's
			// staged chips. Let the loser of that race find the winner's row instead.
			tag = await db.insert(tags).values({ name: tagName }).onConflictDoNothing().returning().get();
			if (!tag) tag = await db.select().from(tags).where(eq(tags.name, tagName)).get();
			// Neither minted nor found: the row was deleted between the conflict and
			// the re-select. Skip the name rather than fail the whole save.
			if (!tag) continue;
		}
		tagIds.push(tag.id);
		written.push(tagName);
	}

	// Every name fell away inside the mint loop — the input had names, and their
	// tag rows went between the conflict and the re-select. Nothing to write, and
	// for an edit-form save nothing to delete either: a save that stored none of
	// what it was given should not clear what the image already had. An input
	// that never had a name is the branch above, which does delete.
	if (tagIds.length === 0) return { written, skipped: false };

	if (options.requireUntagged) {
		// One statement, so the NOT EXISTS is read once — before any of the rows it
		// is about to insert exist. Split over several statements, the second would
		// see the first's rows and refuse. The image had no tag rows by definition
		// of the guard, so there is nothing to delete.
		//
		// The ids ride in as one bound JSON array read through json_each, the way
		// the artist search reads an aliases blob. Binding a parameter a row would
		// put a hundred-tag save over D1's ceiling of 100 per statement and the
		// guard cannot be split, so the choice is this or interpolating the ids
		// into the statement; the array is a single parameter whatever its length.
		const result = await db.run(
			sql`INSERT INTO image_tags (image_id, tag_id)
				SELECT ${imageId}, je.value FROM json_each(${JSON.stringify(tagIds)}) AS je
				WHERE NOT EXISTS (SELECT 1 FROM image_tags WHERE image_id = ${imageId})`
		);
		// No rows changed means the guard refused: something tagged the image
		// between the caller's look and this write.
		if (!result.meta?.changes) return { written: [], skipped: true };
		return { written, skipped: false };
	}

	const inserts = [];
	for (let from = 0; from < tagIds.length; from += ASSOCIATION_CHUNK) {
		const rows = tagIds.slice(from, from + ASSOCIATION_CHUNK).map((tagId) => ({ imageId, tagId }));
		inserts.push(db.insert(imageTags).values(rows));
	}
	// The delete and the inserts commit together or not at all.
	await db.batch([db.delete(imageTags).where(eq(imageTags.imageId, imageId)), ...inserts]);
	return { written, skipped: false };
}
