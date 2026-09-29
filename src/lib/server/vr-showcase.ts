import { and, asc, eq, inArray } from 'drizzle-orm';
import { avatarMedia } from '$lib/server/db/schema';
import { chunk } from '$lib/server/stickers';
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
	// D1 caps bound parameters at ~100 per query, so the IN-list is batched
	// (stickers.ts precedent). An avatar's rows all sit in one batch, and each
	// batch arrives in position order, so the first row seen per avatar wins.
	const batches = await Promise.all(
		chunk(avatarIds).map((ids) =>
			db
				.select({ avatarId: avatarMedia.avatarId, url: avatarMedia.url })
				.from(avatarMedia)
				.where(and(inArray(avatarMedia.avatarId, ids), eq(avatarMedia.kind, 'image')))
				.orderBy(asc(avatarMedia.position))
		)
	);
	for (const row of batches.flat()) {
		if (!result.has(row.avatarId)) result.set(row.avatarId, row.url);
	}
	return result;
}
