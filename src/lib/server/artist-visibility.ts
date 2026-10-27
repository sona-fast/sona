import { fail, type ActionFailure } from '@sveltejs/kit';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Database } from './db';
import { artists } from './db/schema';
import { chunk } from './stickers';

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
 * True for an artist the owner marked "keep private" (artists.ledger_private)
 * who has no public work. The box is the only rule: an artist who exists only
 * for ledger entries but was left unticked counts as public (SONA-236).
 * Actions that would give a private artist public work, or share them, ask
 * first and clear the box, so the box and this check agree; the public-work
 * clause is the backstop for a path that doesn't.
 * Code that sends artist data off the site on its own, like the daily registry
 * sync, the avatar refresh, and the avatar lookup when an artist is saved,
 * skips them. Submit to registry is the owner's explicit share, so it asks
 * first instead.
 *
 * Takes the artists.id column and reads ledger_private from the same row, so
 * call it with `artists.id` from a query over the artists table. Pass
 * `ledgerPrivate` to test a flag value that isn't stored yet, like the one an
 * edit form is about to save.
 */
export function artistIsLedgerOnly(artistId: SQLiteColumn, ledgerPrivate?: boolean): SQL {
	const flagged = ledgerPrivate === undefined ? sql`artists.ledger_private = 1` : sql`${ledgerPrivate ? 1 : 0} = 1`;
	return sql`(${flagged} AND NOT ${artistShownPublicly(artistId)})`;
}

/**
 * True for an artist the site shows: public work (artistHasPublicWork), or a
 * published variant. A variant isn't listed in the gallery, so public counts
 * leave it out, but its own page is served and credits its artist. This is the
 * line Keep private holds (SONA-236): publishing a variant asks first like any
 * other piece.
 */
export function artistShownPublicly(artistId: SQLiteColumn): SQL {
	return sql`(${artistHasPublicWork(artistId)}
		OR EXISTS (SELECT 1 FROM images WHERE images.artist_id = ${artistId} AND images.published = 1))`;
}

/**
 * The Keep private artists among `artistIds` that an action is about to give
 * public work (SONA-236). Without `confirmUnhide=1` in the form, `refusal` is a
 * 409 the page turns into a "make public?" dialog that resubmits with it. Once
 * confirmed, the action does its write and then calls clearKeepPrivate(unhide),
 * so the box keeps matching what the site shows. Pass only the artists the
 * write leaves credited on published work.
 */
export async function checkUnhide(
	db: Database,
	data: FormData,
	artistIds: Array<number | null | undefined>
): Promise<{ refusal: ActionFailure<{ confirmUnhide: string[] }> | null; unhide: number[] }> {
	const ids = [...new Set(artistIds.filter((id): id is number => Number.isInteger(id) && (id as number) > 0))];
	if (!ids.length) return { refusal: null, unhide: [] };
	// A pack can credit 100+ artists, past D1's bound-parameter cap for one query.
	const rows = (
		await Promise.all(
			chunk(ids).map((c) =>
				db
					.select({ id: artists.id, name: artists.name })
					.from(artists)
					.where(and(inArray(artists.id, c), eq(artists.ledgerPrivate, true)))
					.all()
			)
		)
	).flat();
	if (!rows.length) return { refusal: null, unhide: [] };
	if (data.get('confirmUnhide') !== '1') {
		return { refusal: fail(409, { confirmUnhide: rows.map((r) => r.name) }), unhide: [] };
	}
	return { refusal: null, unhide: rows.map((r) => r.id) };
}

/**
 * Unticks Keep private for the confirmed artists the write left on the site.
 * One whose work didn't land (a sticker that failed to download, or was
 * skipped as already in another pack) keeps the box.
 */
export async function clearKeepPrivate(db: Database, artistIds: number[]): Promise<void> {
	for (const c of chunk(artistIds)) {
		await db
			.update(artists)
			.set({ ledgerPrivate: false })
			.where(and(inArray(artists.id, c), artistShownPublicly(artists.id)));
	}
}
