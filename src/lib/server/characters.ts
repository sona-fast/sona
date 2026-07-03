import { asc, eq } from 'drizzle-orm';
import { characters } from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';

/**
 * Character names for public listings (the gallery character filter). Excludes
 * is_owner characters: those are auto-created only to satisfy the stickers
 * character FK on a fork that had no characters yet (see resolveSiteCharacterId),
 * so surfacing them publicly wrongly lists the site owner among the featured cast.
 */
export async function listPublicCharacterNames(db: Database): Promise<{ name: string }[]> {
	return db
		.select({ name: characters.name })
		.from(characters)
		.where(eq(characters.isOwner, false))
		.orderBy(asc(characters.name));
}
