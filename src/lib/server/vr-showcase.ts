import { and, asc, eq, inArray } from 'drizzle-orm';
import { avatarMedia } from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';

/**
 * URL of the first showcase IMAGE per avatar (lowest position, kind='image'),
 * keyed by avatar id. Stands in for the poster on the /admin/vr thumbnail and
 * the /vr card when an avatar has none (the detail page picks its stand-in
 * from the media list it already loads). Video items never qualify — every
 * caller renders the result in an <img>.
 */
export async function firstShowcaseImages(
	db: Database,
	avatarIds: number[]
): Promise<Map<number, string>> {
	const result = new Map<number, string>();
	if (avatarIds.length === 0) return result;
	const rows = await db
		.select({ avatarId: avatarMedia.avatarId, url: avatarMedia.url })
		.from(avatarMedia)
		.where(and(inArray(avatarMedia.avatarId, avatarIds), eq(avatarMedia.kind, 'image')))
		.orderBy(asc(avatarMedia.position));
	// Rows arrive in position order, so the first one seen per avatar wins.
	for (const row of rows) {
		if (!result.has(row.avatarId)) result.set(row.avatarId, row.url);
	}
	return result;
}
