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

/** A label's message function, in paraglide's shape. */
export type CommissionLabel = (
	inputs?: Record<string, never>,
	options?: { locale?: 'en' | 'ja' }
) => string;

// Static references to each message function, never a lookup by computed key:
// a computed key pins the whole catalog into every route that renders a label
// (SONA-169, scripts/check-catalog-pinning.mjs).
export const STATUS_LABELS: Record<CommissionStatus, CommissionLabel> = {
	applied: m.admin_commissions_status_applied,
	waitlisted: m.admin_commissions_status_waitlisted,
	not_picked: m.admin_commissions_status_not_picked,
	accepted: m.admin_commissions_status_accepted,
	in_progress: m.admin_commissions_status_in_progress,
	delivered: m.admin_commissions_status_delivered,
	cancelled: m.admin_commissions_status_cancelled
};

export const PAYMENT_LABELS: Record<CommissionPayment, CommissionLabel> = {
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

export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

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

/**
 * A typed price in the currency's minor units: 45.50 USD is 4550, 45 JPY is
 * 45. Digits only, with at most one decimal point. Too many decimals for the
 * currency are refused rather than rounded, because a rounded price is a
 * different price from the one the owner typed. Works on the digits as text,
 * so 0.1 + 0.2 never enters into it.
 */
export function parsePrice(price: string, currency: string): PriceResult {
	const digits = currencyFractionDigits(currency);
	if (digits === null) return { ok: false, reason: 'format' };
	const match = /^(\d{1,12})(?:\.(\d+))?$/.exec(price);
	if (!match) return { ok: false, reason: 'format' };
	const fraction = match[2] ?? '';
	if (fraction.length > digits) return { ok: false, reason: 'decimals', digits };
	return { ok: true, minor: Number(match[1] + fraction.padEnd(digits, '0')) };
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
