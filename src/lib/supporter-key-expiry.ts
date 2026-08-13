import { formatDate } from '$lib/index';

// Display arithmetic for supporter-key expiry (SONA-119). Isomorphic on
// purpose: the server calls it pinned to UTC (SSR, and the values it keys the
// dismissal cookie on), while the browser calls it unpinned so both the
// "valid until" date and the countdown printed beside it are read off the SAME
// instant in the SAME zone. Reading them in different zones is what let an
// operator east of UTC see "expires today" next to yesterday's date.

const DAY_MS = 86_400_000;

interface Ymd {
	year: number;
	month: number;
	day: number;
}

/** The calendar Y-M-D that `ms` falls on in `timeZone` (the runtime's own zone
 * when omitted — UTC on Workers, the viewer's zone in a browser). */
function ymdIn(ms: number, timeZone?: string): Ymd {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(new Date(ms));
	const read = (type: 'year' | 'month' | 'day') =>
		Number(parts.find((p) => p.type === type)?.value ?? NaN);
	return { year: read('year'), month: read('month'), day: read('day') };
}

/** Days since the epoch for a calendar day — a zone-free ordinal, so two days
 * read in the same zone can be subtracted. */
function epochDay({ year, month, day }: Ymd): number {
	return Date.UTC(year, month - 1, day) / DAY_MS;
}

/** `exp` is end-of-day UTC and exclusive, so the key's last covered moment is
 * one second earlier — that instant, not `exp`, names the day it covers. */
function lastCoveredInstant(expiresAtMs: number): number {
	return expiresAtMs - 1000;
}

/** The "valid until" / "expired" date (dotted YYYY.MM.DD, the repo standard):
 * the last calendar day the key covers, read in `timeZone`. */
export function supporterKeyValidUntil(expiresAtMs: number, timeZone?: string): string {
	const { year, month, day } = ymdIn(lastCoveredInstant(expiresAtMs), timeZone);
	return formatDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}

/**
 * Whole calendar days until the key stops working, counted in `timeZone`: 1
 * means its last covered day is today, 2 means tomorrow, and 0 or less means
 * it has already lapsed. Counting calendar days rather than a wall-clock delta
 * is what ties the number to the date beside it — "expires today" is by
 * construction the case where supporterKeyValidUntil returns today's date.
 */
export function supporterKeyDaysRemaining(
	expiresAtMs: number,
	nowMs: number,
	timeZone?: string
): number {
	return (
		epochDay(ymdIn(lastCoveredInstant(expiresAtMs), timeZone)) - epochDay(ymdIn(nowMs, timeZone)) + 1
	);
}
