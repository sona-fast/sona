import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from './db';
import { artists, characters, commissions, commissionCharacters, images } from './db/schema';
import { sanitizeUrl } from './validate';
import {
	CURRENCY_PATTERN,
	currencyFractionDigits,
	formatMinor,
	isCalendarDate,
	isCommissionPayment,
	isCommissionStatus,
	parsePrice,
	type CommissionPayment,
	type CommissionStatus
} from '$lib/commissions';
import * as m from '$lib/paraglide/messages';

// Commission ledger (SONA-236): form parsing, the reference checks, the writes,
// and the two loads the ledger pages share. Public routes never import this.
//
// SONA-9: nothing here returns created_at, or a value computed from two dates.
// updated_at leaves the server only as the edit form's stale-save token.

export const TITLE_MAX = 120;
export const KIND_MAX = 60;
export const NOTES_MAX = 2000;

export type CommissionField =
	| 'artistId'
	| 'title'
	| 'kind'
	| 'sourceUrl'
	| 'characterIds'
	| 'status'
	| 'payment'
	| 'price'
	| 'currency'
	| 'notes'
	| 'requestedOn'
	| 'acceptedOn'
	| 'deliveredOn';

export type CommissionErrors = Partial<Record<CommissionField, string>>;

export interface CommissionInput {
	artistId: number;
	title: string;
	kind: string | null;
	sourceUrl: string | null;
	characterIds: number[];
	status: CommissionStatus;
	payment: CommissionPayment;
	priceMinor: number | null;
	currency: string | null;
	notes: string | null;
	requestedOn: string | null;
	acceptedOn: string | null;
	deliveredOn: string | null;
}

/** A route segment or form value as a positive integer, or null. A non-numeric
 * id must 404 like an unknown one, not bind NaN into D1, which errors as 500. */
export function parseId(value: unknown): number | null {
	if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function text(data: FormData, name: string): string {
	const value = data.get(name);
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Every field rule from the design doc's table, checked without touching the
 * database. Errors are keyed by field and already localized, so the page ties
 * each one to its input. Values that fail aren't clamped or rounded: a refused
 * save writes nothing, and the owner fixes what they typed.
 */
export function parseCommissionForm(
	data: FormData
): { ok: true; input: CommissionInput } | { ok: false; errors: CommissionErrors } {
	const errors: CommissionErrors = {};

	const artistId = parseId(text(data, 'artistId'));
	if (artistId === null) errors.artistId = m.admin_commissions_error_artist_required();

	const title = text(data, 'title');
	if (!title) errors.title = m.admin_commissions_error_title_required();
	else if (title.length > TITLE_MAX) errors.title = m.admin_commissions_error_too_long({ max: TITLE_MAX });

	const kind = text(data, 'kind');
	if (kind.length > KIND_MAX) errors.kind = m.admin_commissions_error_too_long({ max: KIND_MAX });

	const notes = text(data, 'notes');
	if (notes.length > NOTES_MAX) errors.notes = m.admin_commissions_error_too_long({ max: NOTES_MAX });

	const rawUrl = text(data, 'sourceUrl');
	const sourceUrl = rawUrl ? sanitizeUrl(rawUrl) : null;
	if (rawUrl && !sourceUrl) errors.sourceUrl = m.admin_commissions_error_link();

	const characterIds: number[] = [];
	for (const value of data.getAll('characterId')) {
		const id = parseId(value);
		if (id === null) {
			errors.characterIds = m.admin_commissions_error_characters_unknown();
			break;
		}
		if (!characterIds.includes(id)) characterIds.push(id);
	}

	const status = text(data, 'status');
	if (!isCommissionStatus(status)) errors.status = m.admin_commissions_error_status();
	const payment = text(data, 'payment');
	if (!isCommissionPayment(payment)) errors.payment = m.admin_commissions_error_payment();

	// Price and currency travel together: both or neither.
	const price = text(data, 'price');
	const currency = text(data, 'currency').toUpperCase();
	let priceMinor: number | null = null;
	if (price && !currency) errors.currency = m.admin_commissions_error_currency_missing();
	else if (!price && currency) errors.price = m.admin_commissions_error_price_missing();
	else if (price && currency) {
		if (!CURRENCY_PATTERN.test(currency) || currencyFractionDigits(currency) === null) {
			errors.currency = m.admin_commissions_error_currency_code();
		} else {
			const parsed = parsePrice(price, currency);
			if (parsed.ok) priceMinor = parsed.minor;
			else if (parsed.reason === 'format') errors.price = m.admin_commissions_error_price_format();
			else if (parsed.digits === 0) errors.price = m.admin_commissions_error_price_no_decimals({ currency });
			else errors.price = m.admin_commissions_error_price_decimals({ currency, digits: parsed.digits });
		}
	}

	const dates = {} as Record<'requestedOn' | 'acceptedOn' | 'deliveredOn', string | null>;
	for (const field of ['requestedOn', 'acceptedOn', 'deliveredOn'] as const) {
		const value = text(data, field);
		if (value && !isCalendarDate(value)) errors[field] = m.admin_commissions_error_date();
		dates[field] = value || null;
	}

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return {
		ok: true,
		input: {
			artistId: artistId!,
			title,
			kind: kind || null,
			sourceUrl,
			characterIds,
			status: status as CommissionStatus,
			payment: payment as CommissionPayment,
			priceMinor,
			currency: priceMinor === null ? null : currency,
			notes: notes || null,
			...dates
		}
	};
}

/** The artist and every character must exist. The character ids ride in as one
 * bound JSON array, so a long selection never nears D1's 100-parameter cap. */
export async function checkCommissionRefs(db: Database, input: CommissionInput): Promise<CommissionErrors> {
	const errors: CommissionErrors = {};
	const ids = JSON.stringify(input.characterIds);
	const [artist, found] = await db.batch([
		db.select({ id: artists.id }).from(artists).where(eq(artists.id, input.artistId)),
		db
			.select({ n: sql<number>`COUNT(*)` })
			.from(characters)
			.where(sql`${characters.id} IN (SELECT value FROM json_each(${ids}))`)
	]);
	if (artist.length === 0) errors.artistId = m.admin_commissions_error_artist_unknown();
	if ((found[0]?.n ?? 0) !== input.characterIds.length) {
		errors.characterIds = m.admin_commissions_error_characters_unknown();
	}
	return errors;
}

function fields(input: CommissionInput) {
	return {
		artistId: input.artistId,
		title: input.title,
		kind: input.kind,
		sourceUrl: input.sourceUrl,
		status: input.status,
		payment: input.payment,
		priceMinor: input.priceMinor,
		currency: input.currency,
		notes: input.notes,
		requestedOn: input.requestedOn,
		acceptedOn: input.acceptedOn,
		deliveredOn: input.deliveredOn
	};
}

// The linked piece's title, under its own column name. A D1 batch maps each
// row by column name, so a second plain `title` (the entry's) would collide
// with it and shift every column after it.
const pieceTitleColumn = () => sql<string | null>`${images.title}`.as('piece_title');

/** Inserts the entry and its character links in one batch, so a failure
 * leaves neither. Returns the new entry's id. */
export async function createCommission(db: Database, input: CommissionInput, now: Date = new Date()): Promise<number> {
	const stamp = now.toISOString();
	const ids = JSON.stringify(input.characterIds);
	const [inserted] = await db.batch([
		db
			.insert(commissions)
			.values({ ...fields(input), createdAt: stamp, updatedAt: stamp })
			.returning({ id: commissions.id }),
		// The batch is one transaction, so the newest row is the one just inserted.
		// last_insert_rowid() would move on after the first link row lands.
		db
			.insert(commissionCharacters)
			.select(
				sql`SELECT (SELECT MAX(id) FROM commissions), c.id FROM characters c WHERE c.id IN (SELECT value FROM json_each(${ids}))`
			)
	]);
	return inserted[0].id;
}

/**
 * Saves the entry only if it still carries the `version` (its updated_at) the
 * form loaded with. Another tab or device saving in between changes it, and
 * this save then writes nothing and returns 'stale'.
 *
 * One batch, so one transaction: the link statements run first and the row
 * update last, each guarded on the loaded version. Nothing inside the batch
 * changes updated_at until the last statement, so all three see the same
 * answer: every statement writes, or none does. Guarding the links on the new
 * stamp instead would let a stale save rewrite them whenever another save got
 * the same millisecond.
 */
export async function updateCommission(
	db: Database,
	id: number,
	input: CommissionInput,
	version: string,
	now: Date = new Date()
): Promise<'saved' | 'stale'> {
	// Later than the version it replaces, even when this isolate's clock runs
	// behind the one that wrote it, so an old version never matches again.
	const stamp = new Date(Math.max(now.getTime(), (Date.parse(version) || 0) + 1)).toISOString();
	const ids = JSON.stringify(input.characterIds);
	const current = sql`EXISTS (SELECT 1 FROM commissions WHERE id = ${id} AND updated_at = ${version})`;
	const [, , updated] = await db.batch([
		db.delete(commissionCharacters).where(and(eq(commissionCharacters.commissionId, id), current)),
		db
			.insert(commissionCharacters)
			.select(
				sql`SELECT ${id}, c.id FROM characters c WHERE c.id IN (SELECT value FROM json_each(${ids})) AND ${current}`
			),
		db
			.update(commissions)
			.set({ ...fields(input), updatedAt: stamp })
			.where(and(eq(commissions.id, id), eq(commissions.updatedAt, version)))
			.returning({ id: commissions.id })
	]);
	return updated.length > 0 ? 'saved' : 'stale';
}

/** Deletes the entry and its character links. False when there was no such
 * entry. The links would cascade on D1, which enforces foreign keys; deleting
 * them here as well keeps the result the same wherever foreign keys are off. */
export async function deleteCommission(db: Database, id: number): Promise<boolean> {
	const [, deleted] = await db.batch([
		db.delete(commissionCharacters).where(eq(commissionCharacters.commissionId, id)),
		db.delete(commissions).where(eq(commissions.id, id)).returning({ id: commissions.id })
	]);
	return deleted.length > 0;
}

/**
 * Every entry for the ledger list, newest change first, with its artist, its
 * character names, and its linked piece. Two queries in one round trip: the
 * entries, then every character link. Neither binds a parameter per entry, so
 * the list loads at any size.
 */
export async function listCommissions(db: Database) {
	const [rows, links] = await db.batch([
		db
			.select({
				id: commissions.id,
				title: commissions.title,
				kind: commissions.kind,
				status: commissions.status,
				payment: commissions.payment,
				artistName: artists.name,
				artistAvatarUrl: artists.avatarUrl,
				imageId: commissions.imageId,
				pieceTitle: pieceTitleColumn()
			})
			.from(commissions)
			.innerJoin(artists, eq(commissions.artistId, artists.id))
			.leftJoin(images, eq(commissions.imageId, images.id))
			.orderBy(desc(commissions.updatedAt), desc(commissions.id)),
		db
			.select({ commissionId: commissionCharacters.commissionId, name: characters.name })
			.from(commissionCharacters)
			.innerJoin(characters, eq(commissionCharacters.characterId, characters.id))
			.orderBy(asc(characters.name))
	]);
	const names = new Map<number, string[]>();
	for (const link of links) {
		const list = names.get(link.commissionId) ?? [];
		list.push(link.name);
		names.set(link.commissionId, list);
	}
	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		kind: row.kind,
		status: row.status,
		payment: row.payment,
		artistName: row.artistName,
		artistAvatarUrl: row.artistAvatarUrl,
		characterNames: names.get(row.id) ?? [],
		// A link to a piece that no longer exists reads as not linked.
		piece: row.imageId !== null && row.pieceTitle !== null ? { id: row.imageId, title: row.pieceTitle } : null
	}));
}

/** One entry as the edit page needs it, or null when there's no such entry.
 * The price comes back in its typed form ("45.50"), and `version` is the
 * row's updated_at, sent back on save and never shown. */
export async function loadCommission(db: Database, id: number) {
	const [rows, links] = await db.batch([
		db
			.select({
				id: commissions.id,
				artistId: commissions.artistId,
				artistName: artists.name,
				artistAvatarUrl: artists.avatarUrl,
				title: commissions.title,
				kind: commissions.kind,
				sourceUrl: commissions.sourceUrl,
				status: commissions.status,
				payment: commissions.payment,
				priceMinor: commissions.priceMinor,
				currency: commissions.currency,
				notes: commissions.notes,
				requestedOn: commissions.requestedOn,
				acceptedOn: commissions.acceptedOn,
				deliveredOn: commissions.deliveredOn,
				imageId: commissions.imageId,
				pieceTitle: pieceTitleColumn(),
				version: commissions.updatedAt
			})
			.from(commissions)
			.innerJoin(artists, eq(commissions.artistId, artists.id))
			.leftJoin(images, eq(commissions.imageId, images.id))
			.where(eq(commissions.id, id)),
		db
			.select({ id: commissionCharacters.characterId, name: characters.name })
			.from(commissionCharacters)
			.innerJoin(characters, eq(commissionCharacters.characterId, characters.id))
			.where(eq(commissionCharacters.commissionId, id))
			.orderBy(asc(characters.name))
	]);
	const row = rows[0];
	if (!row) return null;
	const { priceMinor, imageId, pieceTitle, ...rest } = row;
	return {
		...rest,
		price: priceMinor !== null && row.currency ? formatMinor(priceMinor, row.currency) : '',
		characters: links,
		piece: imageId !== null && pieceTitle !== null ? { id: imageId, title: pieceTitle } : null
	};
}

/** The artist and character choices for the entry form. */
export async function loadCommissionChoices(db: Database) {
	const [artistRows, characterRows] = await db.batch([
		db.select({ id: artists.id, name: artists.name }).from(artists).orderBy(asc(artists.name)),
		db
			.select({ id: characters.id, name: characters.name, ownerName: characters.ownerName })
			.from(characters)
			.orderBy(asc(characters.name))
	]);
	return { artists: artistRows, characters: characterRows };
}
