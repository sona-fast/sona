import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { imageTags, tags } from './db/schema';
import { sanitizeTag } from '$lib/tags';

type Db = ReturnType<typeof getDb>;

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
	const tagList = tagNames.split(',').map(sanitizeTag).filter(Boolean);
	for (const tagName of tagList) {
		// A repeated name in the input would otherwise insert the same pair twice.
		if (written.includes(tagName)) continue;
		let tag = await db.select().from(tags).where(eq(tags.name, tagName)).get();
		if (!tag) {
			tag = await db.insert(tags).values({ name: tagName }).returning().get();
		}
		await db.insert(imageTags).values({ imageId, tagId: tag.id });
		written.push(tagName);
	}
	return written;
}
