import { sql, type SQL } from 'drizzle-orm';

/**
 * Everything that stops an artist from being deleted, counted once. The admin
 * artists list selects these counts for each row (so the Delete button can say
 * why it won't run), and the delete action selects the same counts to refuse
 * (the list can be stale). Add a new blocker here and both pick it up.
 *
 * Every one of these is a non-cascading FK to artists.id, so deleting while any
 * count is non-zero would fail or orphan rows.
 */
export type ArtistDeleteBlockers = {
	artworkCount: number;
	stickerCount: number;
	avatarCount: number;
	managedPackCount: number;
	commissionCount: number;
};

/**
 * Correlated COUNT subqueries, keyed like ArtistDeleteBlockers, for a select
 * over the artists table. They name `artists.id` as literal SQL rather than
 * taking the column: in a single-table select, drizzle writes a column inside
 * the select list as a bare "id", which inside each subquery would resolve to
 * the subquery's own table.
 */
export function artistDeleteBlockerCounts(): {
	[K in keyof ArtistDeleteBlockers]: SQL<number>;
} {
	return {
		artworkCount: sql<number>`(SELECT COUNT(*) FROM images WHERE images.artist_id = artists.id)`,
		stickerCount: sql<number>`(SELECT COUNT(*) FROM stickers WHERE stickers.artist_id = artists.id)`,
		// Distinct avatars: an artist credited in two roles on one avatar is one avatar.
		avatarCount: sql<number>`(SELECT COUNT(DISTINCT avatar_id) FROM avatar_credits WHERE avatar_credits.artist_id = artists.id)`,
		// A pack can name this artist as its manager with 0 stickers (e.g. a Telegram
		// import where every download failed), so the sticker count misses it.
		managedPackCount: sql<number>`(SELECT COUNT(*) FROM sticker_packs WHERE sticker_packs.manager_artist_id = artists.id)`,
		// Any status: a private ledger entry keeps its artist.
		commissionCount: sql<number>`(SELECT COUNT(*) FROM commissions WHERE commissions.artist_id = artists.id)`
	};
}

/**
 * The delete action's refusal for the first non-zero blocker, or null when
 * nothing blocks. Hardcoded English, like the rest of the action errors on the
 * admin artists page.
 */
export function artistDeleteBlockedError(c: ArtistDeleteBlockers): string | null {
	if (c.artworkCount > 0) return 'Cannot delete artist with existing artworks. Remove their images first.';
	if (c.stickerCount > 0) return 'Cannot delete artist with existing stickers. Remove their stickers first.';
	if (c.avatarCount > 0)
		return 'Cannot delete artist credited on VR avatars. Remove their credit from each avatar first.';
	if (c.managedPackCount > 0)
		return `Cannot delete artist who manages ${c.managedPackCount} sticker pack${c.managedPackCount === 1 ? '' : 's'}. Reassign or remove those packs first.`;
	if (c.commissionCount > 0)
		return `Cannot delete artist with ${c.commissionCount} commission ledger entr${c.commissionCount === 1 ? 'y' : 'ies'}. Delete those entries first.`;
	return null;
}
