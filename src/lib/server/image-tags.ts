import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { imageTags, tags } from './db/schema';
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
