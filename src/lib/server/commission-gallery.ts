import { and, asc, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from './db';
import type { SQLiteInsertSelectQueryBuilder } from 'drizzle-orm/sqlite-core';
import { commissionCharacters, commissions, images } from './db/schema';
import { commissionGateView } from './commission-gate';
import { parseId } from './commissions';
import { MAX_VARIANT_SET } from './variants';
import { canAddToGallery, isCalendarDate, type CommissionStatus } from '$lib/commissions';

// Add to gallery (SONA-236): the upload page's prefill from a ledger entry, the
// checks a save from an entry passes before anything is written, the one batch
// that inserts the piece and links the entry, and the ledger's "Added to your
// gallery" notice.
//
// ⚠️ Prefill invariant: the upload page gets only the fields in UploadPrefill.
// The entry's link, notes, price, payment, and dates never leave the server,
// and the title feeds only the admin note. commissionedOn never carries a
// ledger date: a new piece starts with none, and a variant starts with its
// piece's own date, so one piece never shows two dates (SONA-9).

export interface UploadPrefill {
	id: number;
	/** Shown only in the admin note "From your commission: TITLE". */
	title: string;
	artistId: number;
	characterIds: number[];
	/** The linked piece, so the upload adds variants to it; null for a new piece. */
	existingParentId: number | null;
	/** The linked piece's own date for a variant; empty for a new piece. */
	commissionedOn: string;
}

/** The upload page's prefill for `/admin/upload?commission=ID`, or null when
 * there's no such entry. */
export async function loadUploadPrefill(db: Database, id: number): Promise<UploadPrefill | null> {
	const [rows, links] = await db.batch([
		db
			.select({
				id: commissions.id,
				title: commissions.title,
				artistId: commissions.artistId,
				imageId: commissions.imageId,
				pieceDate: images.commissionedAt
			})
			.from(commissions)
			.leftJoin(images, eq(commissions.imageId, images.id))
			.where(eq(commissions.id, id)),
		db
			.select({ id: commissionCharacters.characterId })
			.from(commissionCharacters)
			.where(eq(commissionCharacters.commissionId, id))
			.orderBy(asc(commissionCharacters.characterId))
	]);
	const row = rows[0];
	if (!row) return null;
	return {
		id: row.id,
		title: row.title,
		artistId: row.artistId,
		characterIds: links.map((l) => l.id),
		existingParentId: row.imageId,
		commissionedOn: row.imageId !== null ? (row.pieceDate ?? '') : ''
	};
}

/** Why a save from an entry was refused, for the upload page to explain. */
export type CommissionRefusal =
	| { commission: 'missing' }
	| { commission: 'gated'; gaDate: string | null }
	| { commission: 'closed'; status: CommissionStatus }
	| { commission: 'mismatch' }
	| { commission: 'group' }
	| { commission: 'just_added'; imageId: number };

/**
 * Every check a save from an entry passes before an image is written: the
 * entry exists, the gate is open, its status allows it, and the upload's group
 * target matches the entry. A linked entry takes variants of its piece only;
 * an unlinked one takes a new piece only, so an upload never links an entry to
 * a piece already in the gallery.
 *
 * A linked entry with a new-piece upload is the double submit: the first save
 * linked it, so the second gets the 409 the race inside the batch gets.
 */
export async function checkCommissionUpload(
	db: Database,
	env: App.Platform['env'] | undefined,
	rawId: string,
	existingParentId: number | null
): Promise<
	| { ok: true; entry: { id: number; imageId: number | null } }
	| { ok: false; status: 400 | 403 | 409; data: CommissionRefusal }
> {
	const id = parseId(rawId);
	const entry =
		id === null
			? undefined
			: await db
					.select({ id: commissions.id, status: commissions.status, imageId: commissions.imageId })
					.from(commissions)
					.where(eq(commissions.id, id))
					.get();
	if (!entry) return { ok: false, status: 400, data: { commission: 'missing' } };

	const gate = await commissionGateView(db, env);
	if (!gate.open) return { ok: false, status: 403, data: { commission: 'gated', gaDate: gate.gaDate } };

	if (!canAddToGallery(entry.status)) {
		return { ok: false, status: 400, data: { commission: 'closed', status: entry.status } };
	}
	if (entry.imageId === null && existingParentId !== null) {
		return { ok: false, status: 400, data: { commission: 'group' } };
	}
	if (entry.imageId !== null && existingParentId === null) {
		return { ok: false, status: 409, data: { commission: 'just_added', imageId: entry.imageId } };
	}
	if (entry.imageId !== null && existingParentId !== entry.imageId) {
		return { ok: false, status: 400, data: { commission: 'mismatch' } };
	}
	return { ok: true, entry: { id: entry.id, imageId: entry.imageId } };
}

/** The browser's date for an empty Delivered date, or null when it sent none
 * or something that isn't a date. Open question Q17 on SONA-236: built as
 * drawn, the owner's local date fills only an empty Delivered date. */
export function deliveredOnFromForm(value: FormDataEntryValue | null): string | null {
	return typeof value === 'string' && isCalendarDate(value) ? value : null;
}

export interface LinkedPiece {
	title: string;
	slug: string;
	imageUrl: string;
	width: number | null;
	height: number | null;
	fileSize: number | null;
	nsfw: boolean;
	published: boolean;
	sourcePostUrl: string | null;
	artistId: number;
	collectionId: number | null;
	commissionedAt: string | null;
}

/**
 * Inserts a new piece and links the entry to it in one batch, so either both
 * happen or neither. The insert runs only while the entry is still unlinked,
 * and the link finds the piece by its unique slug. When two saves race, the
 * second inserts nothing and links nothing, and this returns null.
 *
 * The entry moves to Delivered, and an empty Delivered date takes
 * `deliveredOn` (the owner's local date). A date the owner set stays. The
 * piece's commissioned date is only what the form sent, never a ledger date.
 */
export async function insertLinkedPiece(
	db: Database,
	entryId: number,
	piece: LinkedPiece,
	deliveredOn: string | null,
	now: Date = new Date()
): Promise<number | null> {
	const stamp = now.toISOString();
	const given: Partial<Record<keyof typeof images.$inferInsert, unknown>> = {
		...piece,
		// Bound as integers: a boolean isn't a value SQLite can bind.
		nsfw: piece.nsfw ? 1 : 0,
		published: piece.published ? 1 : 0,
		featured: 0,
		createdAt: stamp
	};
	// An INSERT … SELECT names every column in table order, so the selection is
	// built from the table: the piece's values, NULL for the rest. A new NOT NULL
	// column needs a value here, or this insert fails its constraint.
	const selection = Object.fromEntries(
		Object.keys(getTableColumns(images)).map((key) => [
			key,
			key in given ? sql`${given[key as keyof typeof given]}` : sql`NULL`
		])
	) as Record<keyof typeof images.$inferSelect, SQL>;
	const [inserted] = await db.batch([
		// One row while the entry is unlinked, none once anything has linked it.
		db
			.insert(images)
			.select(
				(qb) =>
					// Built column by column, the selection's fields are plain SQL and can't
					// carry each column's type; drizzle still checks the keys and their
					// order against the table at runtime.
					qb
						.select(selection)
						.from(commissions)
						.where(
							and(eq(commissions.id, entryId), isNull(commissions.imageId))
						) as unknown as SQLiteInsertSelectQueryBuilder<typeof images>
			)
			.returning({ id: images.id }),
		db
			.update(commissions)
			.set({
				imageId: sql`(SELECT id FROM images WHERE slug = ${piece.slug})`,
				status: 'delivered',
				deliveredOn: sql`COALESCE(${commissions.deliveredOn}, ${deliveredOn})`,
				updatedAt: stamp
			})
			.where(and(eq(commissions.id, entryId), isNull(commissions.imageId)))
	]);
	return inserted[0]?.id ?? null;
}

export type AddedNotice =
	| { kind: 'piece'; imageId: number; title: string; published: boolean }
	| { kind: 'variants'; count: number; published: boolean; pieceId: number; pieceTitle: string };

/**
 * The ledger's notice after an upload from an entry, built from the saved
 * rows rather than anything in the URL: `added` is the entry, and `variants`
 * are the new variant ids. Anything that doesn't check out (no such entry, an
 * unlinked entry, a variant of another piece) shows no notice.
 */
export async function loadAddedNotice(
	db: Database,
	addedRaw: string | null,
	variantsRaw: string | null
): Promise<AddedNotice | null> {
	const entryId = parseId(addedRaw);
	if (entryId === null) return null;
	const piece = await db
		.select({ id: images.id, title: images.title, published: images.published })
		.from(commissions)
		.innerJoin(images, eq(commissions.imageId, images.id))
		.where(eq(commissions.id, entryId))
		.get();
	if (!piece) return null;
	if (variantsRaw === null) {
		return { kind: 'piece', imageId: piece.id, title: piece.title, published: piece.published };
	}
	const ids = variantsRaw.split(',').map(parseId);
	// A variant set is small, so binding one parameter per id stays far under
	// D1's cap; the bound keeps a hand-edited URL from changing that.
	if (ids.length === 0 || ids.length > MAX_VARIANT_SET || ids.some((id) => id === null)) return null;
	const rows = await db
		.select({ parentImageId: images.parentImageId, published: images.published })
		.from(images)
		.where(inArray(images.id, ids as number[]));
	if (rows.length !== new Set(ids).size || rows.some((r) => r.parentImageId !== piece.id)) return null;
	return {
		kind: 'variants',
		count: rows.length,
		published: rows.every((r) => r.published),
		pieceId: piece.id,
		pieceTitle: piece.title
	};
}
