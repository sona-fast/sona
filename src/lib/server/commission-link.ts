import { fail } from '@sveltejs/kit';
import { and, desc, eq, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Database } from './db';
import { artists, commissions, images } from './db/schema';
import { parseId } from './commissions';
import { CLOSED_STATUSES, canAddToGallery, isCalendarDate } from '$lib/commissions';

// Link a piece (SONA-236): an entry whose art is already in the gallery links
// to that piece instead of uploading it a second time. The picker's list, the
// link, and the unlink.
//
// Linking changes only the entry: the piece's artist, published flag, and
// every other column stay as they were, so nothing a visitor sees changes and
// a Keep private artist stays as private as they were. Unlinking clears the
// entry's image_id and never touches the piece.

/** How many pieces the picker shows at once. A search finds the rest. */
export const PICKER_LIMIT = 60;

export type PickerScope = 'artist' | 'all';

export interface PickerPiece {
	id: number;
	title: string;
	thumb: string | null;
	published: boolean;
	artistName: string;
	/** Linked to another entry, so it can't be picked. */
	taken: boolean;
}

export interface PickerList {
	scope: PickerScope;
	query: string;
	artistName: string;
	pieces: PickerPiece[];
	/** More pieces match than the picker shows. */
	more: boolean;
}

/** The picker's scope from a query value: everything only when asked for. */
export function pickerScope(value: string | null): PickerScope {
	return value === 'all' ? 'all' : 'artist';
}

/**
 * The pieces the picker offers for an entry, newest first: top-level pieces
 * only (a variant belongs to its piece), by the entry's artist unless `scope`
 * is 'all', and whose title contains `query`. Null when there's no such entry.
 * instr() rather than LIKE, so a % or _ in the search is just a character.
 */
export async function listLinkablePieces(
	db: Database,
	entryId: number,
	{ scope, query }: { scope: PickerScope; query: string }
): Promise<PickerList | null> {
	const entry = await db
		.select({ artistId: commissions.artistId, artistName: artists.name })
		.from(commissions)
		.innerJoin(artists, eq(commissions.artistId, artists.id))
		.where(eq(commissions.id, entryId))
		.get();
	if (!entry) return null;
	const q = query.trim().slice(0, 100);
	const conditions: SQL[] = [isNull(images.parentImageId)];
	if (scope === 'artist') conditions.push(eq(images.artistId, entry.artistId));
	if (q) conditions.push(sql`instr(lower(${images.title}), lower(${q})) > 0`);
	const rows = await db
		.select({
			id: images.id,
			title: images.title,
			thumb: sql<string | null>`COALESCE(NULLIF(${images.thumbnailUrl}, ''), ${images.imageUrl})`,
			published: images.published,
			artistName: artists.name,
			takenBy: commissions.id
		})
		.from(images)
		.innerJoin(artists, eq(images.artistId, artists.id))
		.leftJoin(commissions, eq(commissions.imageId, images.id))
		.where(and(...conditions))
		.orderBy(desc(images.createdAt), desc(images.id))
		.limit(PICKER_LIMIT + 1);
	return {
		scope,
		query: q,
		artistName: entry.artistName,
		more: rows.length > PICKER_LIMIT,
		pieces: rows.slice(0, PICKER_LIMIT).map(({ takenBy, ...piece }) => ({
			...piece,
			// The entry's own piece isn't "taken": the picker only opens for an
			// unlinked entry, but a race could show it.
			taken: takenBy !== null && takenBy !== entryId
		}))
	};
}

/** Why a link was refused. */
export type LinkRefusal =
	/** No such entry. */
	| 'missing'
	/** The entry changed since the form loaded (or since the checks read it). */
	| 'stale'
	/** The entry is marked Not picked or Canceled. */
	| 'closed'
	/** The entry already has a piece. */
	| 'linked'
	/** No such piece. */
	| 'no_piece'
	| 'variant'
	/** Another entry links the piece. */
	| 'taken';

/** Whether a write failed on the one-entry-per-piece index. */
function pieceTaken(e: unknown): boolean {
	for (let c: unknown = e; c instanceof Error; c = c.cause) {
		if (/UNIQUE constraint failed: commissions\.image_id/.test(c.message)) return true;
	}
	return false;
}

/** Later than `version`, even when this isolate's clock runs behind the one that
 * wrote it, so an old version never matches again (as updateCommission does). */
function nextStamp(version: string, now: Date): string {
	return new Date(Math.max(now.getTime(), (Date.parse(version) || 0) + 1)).toISOString();
}

/**
 * Links an existing piece to the entry, as Add to gallery links a new one: the
 * entry moves to Delivered, and an empty Delivered date takes `deliveredOn`
 * (the owner's local date), while a date the owner set stays.
 *
 * `version` is the entry's updated_at the form loaded with; the edit page sends
 * it, and a link from an out-of-date form writes nothing, as a save does. The
 * ledger list holds no form, so it passes null and the link guards on the
 * version read here instead.
 *
 * The update runs only while the entry is still unlinked, still open, still at
 * that version, and the piece is still a top-level piece. The unique index on
 * image_id refuses a piece another entry took in between, which comes back as
 * 'taken' rather than an error.
 */
export async function linkPiece(
	db: Database,
	entryId: number,
	imageId: number,
	{ version, deliveredOn, now = new Date() }: { version: string | null; deliveredOn: string | null; now?: Date }
): Promise<{ ok: true; version: string } | { ok: false; reason: LinkRefusal }> {
	const [entries, pieces, takers] = await db.batch([
		db
			.select({ status: commissions.status, imageId: commissions.imageId, version: commissions.updatedAt })
			.from(commissions)
			.where(eq(commissions.id, entryId)),
		db.select({ parentImageId: images.parentImageId }).from(images).where(eq(images.id, imageId)),
		db.select({ id: commissions.id }).from(commissions).where(eq(commissions.imageId, imageId))
	]);
	const entry = entries[0];
	if (!entry) return { ok: false, reason: 'missing' };
	if (version !== null && entry.version !== version) return { ok: false, reason: 'stale' };
	if (!canAddToGallery(entry.status)) return { ok: false, reason: 'closed' };
	if (entry.imageId !== null) return { ok: false, reason: 'linked' };
	const piece = pieces[0];
	if (!piece) return { ok: false, reason: 'no_piece' };
	if (piece.parentImageId !== null) return { ok: false, reason: 'variant' };
	if (takers.some((t) => t.id !== entryId)) return { ok: false, reason: 'taken' };

	const stamp = nextStamp(entry.version, now);
	let updated: { id: number }[];
	try {
		updated = await db
			.update(commissions)
			.set({
				imageId,
				status: 'delivered',
				deliveredOn: sql`COALESCE(${commissions.deliveredOn}, ${deliveredOn})`,
				updatedAt: stamp
			})
			.where(
				and(
					eq(commissions.id, entryId),
					eq(commissions.updatedAt, entry.version),
					isNull(commissions.imageId),
					notInArray(commissions.status, [...CLOSED_STATUSES]),
					sql`EXISTS (SELECT 1 FROM images WHERE images.id = ${imageId} AND images.parent_image_id IS NULL)`
				)
			)
			.returning({ id: commissions.id });
	} catch (e) {
		if (pieceTaken(e)) return { ok: false, reason: 'taken' };
		throw e;
	}
	// Something changed between the checks and the write: the owner looks again.
	if (updated.length === 0) return { ok: false, reason: 'stale' };
	return { ok: true, version: stamp };
}

/**
 * Clears the entry's link to its piece, only while the entry still carries the
 * `version` the form loaded with. The piece stays in the gallery as it was.
 * An entry with no piece is already unlinked, which counts as done.
 */
export async function unlinkPiece(
	db: Database,
	entryId: number,
	version: string,
	now: Date = new Date()
): Promise<{ ok: true; version: string } | { ok: false; reason: 'missing' | 'stale' }> {
	const stamp = nextStamp(version, now);
	const updated = await db
		.update(commissions)
		.set({ imageId: null, updatedAt: stamp })
		.where(and(eq(commissions.id, entryId), eq(commissions.updatedAt, version)))
		.returning({ id: commissions.id });
	if (updated.length > 0) return { ok: true, version: stamp };
	const entry = await db
		.select({ version: commissions.updatedAt })
		.from(commissions)
		.where(eq(commissions.id, entryId))
		.get();
	return { ok: false, reason: entry ? 'stale' : 'missing' };
}

/** The piece and the owner's local date a link form sends. A malformed piece
 * id reads as no piece. */
export function linkFormValues(data: FormData): { imageId: number | null; deliveredOn: string | null } {
	const sent = data.get('deliveredOn');
	return {
		imageId: parseId(data.get('imageId')),
		deliveredOn: typeof sent === 'string' && isCalendarDate(sent) ? sent : null
	};
}

/** A refused link or unlink as the action's answer. A missing entry and an
 * out-of-date one answer as Save does; the rest name the reason under `link`. */
export function linkFailure(reason: LinkRefusal) {
	if (reason === 'missing') return fail(404, { missing: true });
	if (reason === 'stale') return fail(409, { stale: true });
	return fail(reason === 'taken' || reason === 'linked' ? 409 : 400, { link: reason });
}
