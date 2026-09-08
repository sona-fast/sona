import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { imageTags, tags } from './db/schema';
import { sanitizeText } from './validate';
import { sanitizeTag } from '$lib/tags';

type Db = ReturnType<typeof getDb>;

/** Ceiling on how many tags one save keeps, counted after sanitizing and
 * de-duplicating. The edit form and the Suggest tags page both write through
 * here, so this is the one place the two save paths agree on a limit. */
export const MAX_IMAGE_TAGS = 100;

/** Ceiling on the raw Tags field, in characters. Room for MAX_IMAGE_TAGS names
 * of realistic length, so an input the count guard would accept is never cut
 * first: a field truncated mid-name stores the fragment and reports success,
 * which is the failure the count guard exists to prevent. Past this the save
 * actions refuse rather than truncate. */
export const MAX_TAGS_INPUT_LENGTH = 4000;

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
 * Returns the sanitized value alongside the problem, so a caller that accepts
 * the input writes the same string this counted. The three actions word their
 * refusals differently, so the problem is named rather than phrased here.
 */
export function readTagInput(raw: string): {
	problem: 'too_long' | 'too_many' | null;
	value: string;
} {
	if (raw.length > MAX_TAGS_INPUT_LENGTH) return { problem: 'too_long', value: '' };
	const value = sanitizeText(raw, MAX_TAGS_INPUT_LENGTH);
	if (parseImageTags(value).length > MAX_IMAGE_TAGS) return { problem: 'too_many', value };
	return { problem: null, value };
}

/**
 * Replace an image's tags with the ones in a comma-separated string, minting
 * any tag row that does not exist yet.
 *
 * Extracted from the edit form's save action (SONA-220) so the Suggest tags
 * page writes tags the same way the form does: same sanitizer, same
 * delete-then-insert, same tag table. Returns the tag names actually written,
 * so a caller can say how many landed.
 */
export async function replaceImageTags(db: Db, imageId: number, tagNames: string): Promise<string[]> {
	await db.delete(imageTags).where(eq(imageTags.imageId, imageId));

	// An empty field still deletes: clearing the Tags box on the edit form is how
	// an image loses its tags. A caller with nothing to delete — a just-inserted
	// image — skips this function instead.
	if (!tagNames) return [];

	const written: string[] = [];
	for (const tagName of parseImageTags(tagNames)) {
		// The actions refuse an over-cap input before they write; this is the net
		// under anything that reaches here by another path.
		if (written.length >= MAX_IMAGE_TAGS) break;
		let tag = await db.select().from(tags).where(eq(tags.name, tagName)).get();
		if (!tag) {
			tag = await db.insert(tags).values({ name: tagName }).returning().get();
		}
		await db.insert(imageTags).values({ imageId, tagId: tag.id });
		written.push(tagName);
	}
	return written;
}
