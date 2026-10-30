/**
 * Commission ledger (SONA-236): the client-safe half. The ledger pages and the
 * server actions share these lists, labels, and the price and date rules, so
 * the browser and the server can't disagree about what a valid entry is.
 *
 * The status and payment lists copy the enums in $lib/server/db/schema.ts,
 * which the browser can't import. commissions.test.ts pins the copies to the
 * schema's enumValues.
 *
 * Nothing here subtracts two dates or measures time between steps (SONA-9).
 * The dates are the owner's record, shown as plain dates and nothing else.
 */

import { formatDate } from '$lib/index';
import type { EarlyAccessLabel } from '$lib/early-access';
import * as m from '$lib/paraglide/messages';

export const COMMISSION_STATUSES = [
	'applied',
	'waitlisted',
	'not_picked',
	'accepted',
	'in_progress',
	'delivered',
	'cancelled'
] as const;
export const COMMISSION_PAYMENTS = ['unpaid', 'deposit', 'paid', 'refunded'] as const;

export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];
export type CommissionPayment = (typeof COMMISSION_PAYMENTS)[number];

// Field limits from the design doc's table. The server enforces them, and the
// form's maxlength attributes come from the same numbers.
export const TITLE_MAX = 120;
export const KIND_MAX = 60;
export const NOTES_MAX = 2000;
/** "Where it's happening" as plain text, such as "Telegram DM". A link can be
 * longer, up to sanitizeUrl's cap. */
export const SOURCE_TEXT_MAX = 120;

/**
 * The address a "Where it's happening" value links to, or null when the value
 * is plain text. A link is one word that reads as a web address, with or
 * without its https:// ("vgen.co/taro" counts). Anything with a space, a
 * scheme other than http(s), or a host without a dot is text: it's stored and
 * shown as typed, never as a link, and never sent to the artist lookup.
 */
export function sourceLinkHref(value: string | null | undefined): string | null {
	const text = value?.trim() ?? '';
	if (!text || /\s/.test(text)) return null;
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (!url.hostname.includes('.')) return null;
	return url.href;
}

/** The entry form's fields, as the server keys its errors. */
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

export function isCommissionStatus(value: unknown): value is CommissionStatus {
	return (COMMISSION_STATUSES as readonly unknown[]).includes(value);
}

export function isCommissionPayment(value: unknown): value is CommissionPayment {
	return (COMMISSION_PAYMENTS as readonly unknown[]).includes(value);
}

/** Entries still waiting on something. The rest (delivered, not picked,
 * cancelled) list under Finished. */
const ACTIVE: ReadonlySet<CommissionStatus> = new Set(['applied', 'waitlisted', 'accepted', 'in_progress']);

export function isActiveStatus(status: CommissionStatus): boolean {
	return ACTIVE.has(status);
}

/** Entries marked these never go to the gallery: there's no art to add. The
 * save's own guard in the database reads the same list. */
export const CLOSED_STATUSES = ['not_picked', 'cancelled'] as const satisfies readonly CommissionStatus[];

export function canAddToGallery(status: CommissionStatus): boolean {
	return !(CLOSED_STATUSES as readonly CommissionStatus[]).includes(status);
}

// Static references to each message function, never a lookup by computed key:
// a computed key pins the whole catalog into every route that renders a label
// (SONA-169, scripts/check-catalog-pinning.mjs).
export const STATUS_LABELS: Record<CommissionStatus, EarlyAccessLabel> = {
	applied: m.admin_commissions_status_applied,
	waitlisted: m.admin_commissions_status_waitlisted,
	not_picked: m.admin_commissions_status_not_picked,
	accepted: m.admin_commissions_status_accepted,
	in_progress: m.admin_commissions_status_in_progress,
	delivered: m.admin_commissions_status_delivered,
	cancelled: m.admin_commissions_status_cancelled
};

export const PAYMENT_LABELS: Record<CommissionPayment, EarlyAccessLabel> = {
	unpaid: m.admin_commissions_payment_unpaid,
	deposit: m.admin_commissions_payment_deposit,
	paid: m.admin_commissions_payment_paid,
	refunded: m.admin_commissions_payment_refunded
};

/** The status chip's tint. The label text carries the status, so the tint is
 * never the only signal (SONA-81). */
export const STATUS_TONES: Record<CommissionStatus, '' | 'progress' | 'done' | 'closed'> = {
	applied: '',
	waitlisted: '',
	accepted: 'progress',
	in_progress: 'progress',
	delivered: 'done',
	not_picked: 'closed',
	cancelled: 'closed'
};

export interface CommissionDates {
	requestedOn: string;
	acceptedOn: string;
	deliveredOn: string;
}

/** The date a status fills when the owner moves an entry to it. Only the edit
 * form applies this, in the browser, so the owner sees the date before saving
 * and can change or clear it. Open question Q17 on SONA-236 asks who should
 * fill dates; this map is the one place to change if the answer moves. */
const DATE_FILLED_BY_STATUS: Partial<Record<CommissionStatus, keyof CommissionDates>> = {
	accepted: 'acceptedOn',
	delivered: 'deliveredOn'
};

/** The dates after the owner picks `status`: the step's date becomes `today`
 * when it's empty, and a date the owner already set stays as it is. */
export function datesAfterStatusChange(
	status: CommissionStatus,
	dates: CommissionDates,
	today: string
): CommissionDates {
	const field = DATE_FILLED_BY_STATUS[status];
	if (!field || dates[field]) return dates;
	return { ...dates, [field]: today };
}

/** Today's date where the browser is, as YYYY-MM-DD. A UTC date would be a day
 * off for owners east or west of it around midnight. */
export function localToday(now: Date = new Date()): string {
	const mo = String(now.getMonth() + 1).padStart(2, '0');
	const da = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${mo}-${da}`;
}

/** A real calendar date in YYYY-MM-DD form. 2026-02-30 has the right shape
 * but no such day, so the shape alone isn't enough. */
export function isCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const [y, mo, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(y, mo - 1, d));
	return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** How many minor-unit digits a currency uses: 2 for USD, 0 for JPY, 3 for
 * BHD. Null when the code isn't one Intl accepts. */
export function currencyFractionDigits(currency: string): number | null {
	if (!CURRENCY_PATTERN.test(currency)) return null;
	try {
		return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
			.maximumFractionDigits ?? null;
	} catch {
		return null;
	}
}

export type PriceResult =
	| { ok: true; minor: number }
	| { ok: false; reason: 'format' }
	| { ok: false; reason: 'decimals'; digits: number };

/** The digit-group separator `locale` writes: "," in en and ja, "." in de. */
function groupSeparator(locale: string): string {
	return new Intl.NumberFormat(locale).formatToParts(1234567).find((p) => p.type === 'group')?.value ?? ',';
}

/**
 * A typed amount as plain digits and an optional fraction, or null when it
 * can't be read as one number. Full-width digits and punctuation count as
 * their ASCII forms. Spaces (including NBSP and narrow NBSP) and apostrophes
 * only ever group digits. Of "," and ".": with both present, the last one is
 * the decimal; one kind appearing more than once groups; one appearing once
 * before exactly three digits (1,000) groups when it's `locale`'s group
 * separator and is the decimal otherwise; once before any other count of
 * digits, it's the decimal. Grouping must be in threes after a first group of
 * one to three digits, with one separator kind throughout.
 */
function normalizeAmount(price: string, locale: string): { whole: string; fraction: string } | null {
	const text = price.normalize('NFKC').replace(/[\s  ]/g, ' ').replace(/’/g, "'").trim();
	if (!/^\d+(?:[ ',.]\d+)*$/.test(text)) return null;
	const runs = text.split(/[ ',.]/);
	const seps: string[] = text.match(/[ ',.]/g) ?? [];
	const marks = seps.filter((s) => s === ',' || s === '.');
	const last = seps.length - 1;

	// Which separator, by position, is the decimal one; -1 when there's none.
	let decimal = -1;
	if (new Set(marks).size === 2) {
		decimal = Math.max(seps.lastIndexOf(','), seps.lastIndexOf('.'));
		if (marks.filter((s) => s === seps[decimal]).length > 1) return null;
	} else if (marks.length === 1) {
		const at = seps.indexOf(marks[0]);
		const groups = runs[at + 1].length === 3 && marks[0] === groupSeparator(locale);
		if (!groups) decimal = at;
	}
	// The decimal comes after every group.
	if (decimal !== -1 && decimal !== last) return null;

	const groupSeps = decimal === -1 ? seps : seps.slice(0, -1);
	const groups = decimal === -1 ? runs : runs.slice(0, -1);
	if (groupSeps.length > 0) {
		if (new Set(groupSeps).size > 1) return null;
		if (groups[0].length > 3 || groups.slice(1).some((g) => g.length !== 3)) return null;
	}
	return { whole: groups.join(''), fraction: decimal === -1 ? '' : runs[runs.length - 1] };
}

/**
 * A typed price in the currency's minor units: 45.50 USD is 4550, 45 JPY is
 * 45. normalizeAmount reads the typing first, in the admin's `locale`. Too many
 * decimals for the currency are refused rather than rounded, because a
 * rounded price is a different price from the one the owner typed. Works on
 * the digits as text, so 0.1 + 0.2 never enters into it.
 */
export function parsePrice(price: string, currency: string, locale: string): PriceResult {
	const digits = currencyFractionDigits(currency);
	if (digits === null) return { ok: false, reason: 'format' };
	const amount = normalizeAmount(price, locale);
	if (!amount || amount.whole.length > 12) return { ok: false, reason: 'format' };
	const { whole, fraction } = amount;
	if (fraction.length > digits) return { ok: false, reason: 'decimals', digits };
	// Currencies with four minor digits (CLF, UYW) put twelve whole digits past
	// what a double holds exactly, and a rounded price is a different price.
	const minor = Number(whole + fraction.padEnd(digits, '0'));
	if (!Number.isSafeInteger(minor)) return { ok: false, reason: 'format' };
	return { ok: true, minor };
}

/** Minor units back to the typed form: 4550 USD is "45.50", 45 JPY is "45". */
export function formatMinor(minor: number, currency: string): string {
	const digits = currencyFractionDigits(currency) ?? 2;
	if (digits === 0) return String(minor);
	const text = String(minor).padStart(digits + 1, '0');
	return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** The read-only entry view's date rows: each date the owner set, as a plain
 * date and nothing else. One function so the SONA-9 rule has one place to
 * hold: no row says how long anything took or how long ago it was. */
export function commissionDateRows(dates: {
	requestedOn: string | null;
	acceptedOn: string | null;
	deliveredOn: string | null;
}): { label: string; value: string }[] {
	const rows: { label: string; value: string | null }[] = [
		{ label: m.admin_commissions_field_requested(), value: dates.requestedOn },
		{ label: m.admin_commissions_field_accepted(), value: dates.acceptedOn },
		{ label: m.admin_commissions_field_delivered(), value: dates.deliveredOn }
	];
	return rows.flatMap((row) => (row.value ? [{ label: row.label, value: formatDate(row.value) }] : []));
}

/** What the entry form holds, as strings the inputs bind to. */
export interface CommissionFormValues {
	artistId: string;
	title: string;
	kind: string;
	sourceUrl: string;
	characterIds: number[];
	status: CommissionStatus;
	payment: CommissionPayment;
	price: string;
	currency: string;
	notes: string;
	requestedOn: string;
	acceptedOn: string;
	deliveredOn: string;
}

/** The entry the edit page loads, as far as the form reads it. */
export interface CommissionFormEntry {
	artistId: number;
	title: string;
	kind: string | null;
	sourceUrl: string | null;
	characters: { id: number }[];
	status: CommissionStatus;
	payment: CommissionPayment;
	price: string;
	currency: string | null;
	notes: string | null;
	requestedOn: string | null;
	acceptedOn: string | null;
	deliveredOn: string | null;
}

/** The form's starting values: the entry's, or an empty new entry's. */
export function formValuesOf(entry: CommissionFormEntry | null): CommissionFormValues {
	return {
		artistId: entry ? String(entry.artistId) : '',
		title: entry?.title ?? '',
		kind: entry?.kind ?? '',
		sourceUrl: entry?.sourceUrl ?? '',
		characterIds: entry ? entry.characters.map((c) => c.id) : [],
		status: entry?.status ?? 'applied',
		payment: entry?.payment ?? 'unpaid',
		price: entry?.price ?? '',
		currency: entry?.currency ?? '',
		notes: entry?.notes ?? '',
		requestedOn: entry?.requestedOn ?? '',
		acceptedOn: entry?.acceptedOn ?? '',
		deliveredOn: entry?.deliveredOn ?? ''
	};
}

/** Every field, in the order the form shows them. The form focuses the first
 * one with an error. */
export const FIELD_ORDER: CommissionField[] = [
	'sourceUrl',
	'artistId',
	'title',
	'kind',
	'characterIds',
	'notes',
	'status',
	'payment',
	'price',
	'currency',
	'requestedOn',
	'acceptedOn',
	'deliveredOn'
];

/** What Reload entry drops: every field but Notes, which it brings back. */
const RELOAD_LOSES = FIELD_ORDER.filter((f): f is Exclude<CommissionField, 'notes'> => f !== 'notes');

/** The fields besides Notes that the owner changed since the form loaded.
 * Characters compare as a set: picking the same ones in another order is no
 * change. */
export function changedFields(
	loaded: CommissionFormValues,
	current: CommissionFormValues
): Exclude<CommissionField, 'notes'>[] {
	const sameSet = (a: number[], b: number[]) =>
		[...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();
	return RELOAD_LOSES.filter((field) =>
		field === 'characterIds'
			? !sameSet(loaded.characterIds, current.characterIds)
			: loaded[field] !== current[field]
	);
}

const FIELD_NAMES: Record<Exclude<CommissionField, 'notes'>, EarlyAccessLabel> = {
	sourceUrl: m.admin_commissions_field_link_short,
	artistId: m.admin_commissions_field_artist,
	title: m.admin_commissions_field_title,
	kind: m.admin_commissions_field_kind,
	characterIds: m.admin_commissions_field_characters,
	status: m.admin_commissions_field_status,
	payment: m.admin_commissions_field_payment,
	price: m.admin_commissions_field_price,
	currency: m.admin_commissions_field_currency,
	requestedOn: m.admin_commissions_field_requested,
	acceptedOn: m.admin_commissions_field_accepted,
	deliveredOn: m.admin_commissions_field_delivered
};

/**
 * The refusal shown when a save is out of date: what happened, then what
 * Reload entry keeps and what it loses. Computed once, when the refusal
 * arrives, so the alert's text doesn't change while the owner keeps typing.
 */
export function staleMessage(
	loaded: CommissionFormValues,
	current: CommissionFormValues,
	locale: 'en' | 'ja'
): string {
	const options = { locale };
	const head = m.admin_commissions_stale({}, options);
	const changed = changedFields(loaded, current).map((field) => FIELD_NAMES[field]({}, options));
	const fields = new Intl.ListFormat(locale, { type: 'conjunction' }).format(changed);
	const noteChanged = loaded.notes !== current.notes;
	const detail = noteChanged
		? changed.length > 0
			? m.admin_commissions_stale_note_and_fields({ fields }, options)
			: m.admin_commissions_stale_note({}, options)
		: changed.length > 0
			? m.admin_commissions_stale_fields({ fields }, options)
			: '';
	// Japanese runs sentences together; English separates them with a space.
	const join = locale === 'ja' ? '' : ' ';
	return detail ? `${head}${join}${detail}` : head;
}

/**
 * Reload entry: the current entry, with the note the owner typed put back
 * when they had changed it. `restoredNote` says which hint Notes shows:
 * 'kept' when the saved note is still the one the form loaded with, and
 * 'replaces' when the other change also edited it, so saving would replace it.
 */
export function mergeReloaded(
	fresh: CommissionFormValues,
	loadedNote: string,
	typedNote: string
): { values: CommissionFormValues; restoredNote: '' | 'kept' | 'replaces' } {
	if (typedNote === loadedNote) return { values: fresh, restoredNote: '' };
	return {
		values: { ...fresh, notes: typedNote },
		restoredNote: fresh.notes === loadedNote ? 'kept' : 'replaces'
	};
}
