import { sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * True for an artist with public work: a published gallery piece (the gallery
 * filter's rule: published and not a variant), a sticker in a published pack or
 * a published pack they manage, or a credit on a published VR avatar.
 *
 * Public counts use this instead of counting every artist row, because an
 * artist can exist only for the owner's private commission ledger (SONA-236),
 * and that must not show on a public page. The admin Works column can't be
 * reused: it counts drafts too.
 */
export function artistHasPublicWork(artistId: SQLiteColumn): SQL {
	return sql`(
		EXISTS (SELECT 1 FROM images WHERE images.artist_id = ${artistId} AND images.published = 1 AND images.parent_image_id IS NULL)
		OR EXISTS (SELECT 1 FROM stickers JOIN sticker_packs ON sticker_packs.id = stickers.pack_id
			WHERE stickers.artist_id = ${artistId} AND sticker_packs.published = 1)
		OR EXISTS (SELECT 1 FROM sticker_packs WHERE sticker_packs.manager_artist_id = ${artistId} AND sticker_packs.published = 1)
		OR EXISTS (SELECT 1 FROM avatar_credits JOIN vr_avatars ON vr_avatars.id = avatar_credits.avatar_id
			WHERE avatar_credits.artist_id = ${artistId} AND vr_avatars.published = 1)
	)`;
}

/**
 * True for an artist who exists only for the owner's private commission ledger.
 * Either rule makes them private:
 *  - they have entries, and no piece (published or not), sticker, managed pack,
 *    or avatar credit;
 *  - the owner ticked "keep private" (artists.ledger_private) and they have no
 *    public work, so publishing work by them ends it on its own.
 * Code that sends artist data off the site on its own, like the daily registry
 * sync, the avatar refresh, and the avatar lookup when an artist is saved,
 * skips them (SONA-236). Submit to registry is the owner's explicit share, so
 * it asks first instead.
 *
 * Takes the artists.id column and reads ledger_private from the same row, so
 * call it with `artists.id` from a query over the artists table. Pass
 * `ledgerPrivate` to test a flag value that isn't stored yet, like the one an
 * edit form is about to save.
 */
export function artistIsLedgerOnly(artistId: SQLiteColumn, ledgerPrivate?: boolean): SQL {
	const flagged = ledgerPrivate === undefined ? sql`artists.ledger_private = 1` : sql`${ledgerPrivate ? 1 : 0} = 1`;
	return sql`((
		EXISTS (SELECT 1 FROM commissions WHERE commissions.artist_id = ${artistId})
		AND NOT EXISTS (SELECT 1 FROM images WHERE images.artist_id = ${artistId})
		AND NOT EXISTS (SELECT 1 FROM stickers WHERE stickers.artist_id = ${artistId})
		AND NOT EXISTS (SELECT 1 FROM sticker_packs WHERE sticker_packs.manager_artist_id = ${artistId})
		AND NOT EXISTS (SELECT 1 FROM avatar_credits WHERE avatar_credits.artist_id = ${artistId})
	) OR (${flagged} AND NOT ${artistHasPublicWork(artistId)}))`;
}
