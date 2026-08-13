import { formatDate } from '$lib/index';

// Display arithmetic for supporter-key expiry (SONA-119). Every caller passes
// the SAME zone for both the "valid until" date and the countdown printed
// beside it, which is what stops them disagreeing: reading one in UTC and the
// other on the wall clock is how an operator east of UTC came to see "expires
// today" next to a date that read as yesterday where they were sitting.
//
// Server-side on purpose. The zone is the viewer's, resolved from the tz cookie
// (see viewerTimeZone below) rather than in the browser — computing it client-
// side would make SSR render the UTC answer and hydration visibly overwrite it.

const DAY_MS = 86_400_000;

/** The calendar day `ms` falls on in `timeZone`, as YYYY-MM-DD. en-CA is the
 * locale ICU renders in that order. */
function isoDayIn(ms: number, timeZone: string): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(new Date(ms));
}

/** Days since the epoch for a YYYY-MM-DD — a zone-free ordinal, so two days
 * read in the same zone can be subtracted. */
function epochDay(isoDay: string): number {
	const [year, month, day] = isoDay.split('-').map(Number);
	return Date.UTC(year, month - 1, day) / DAY_MS;
}

/**
 * The operator's IANA zone from the `tz` cookie, falling back to UTC when it is
 * absent (no JS, or their first admin page view) or not a zone this runtime
 * knows. The value is attacker-suppliable, and an unknown zone makes
 * Intl.DateTimeFormat throw a RangeError, so it is validated by use before it
 * can take down the admin layout load.
 */
export function viewerTimeZone(cookie: string | undefined): string {
	if (!cookie) return 'UTC';
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone: cookie });
		return cookie;
	} catch {
		return 'UTC';
	}
}

/** `exp` is end-of-day UTC and exclusive, so the key's last covered moment is
 * one second earlier — that instant, not `exp`, names the day it covers. */
function lastCoveredInstant(expiresAtMs: number): number {
	return expiresAtMs - 1000;
}

/** The "valid until" / "expired" date (dotted YYYY.MM.DD, the repo standard):
 * the last calendar day the key covers, read in `timeZone`. */
export function supporterKeyValidUntil(expiresAtMs: number, timeZone: string): string {
	return formatDate(isoDayIn(lastCoveredInstant(expiresAtMs), timeZone));
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
	timeZone: string
): number {
	return (
		epochDay(isoDayIn(lastCoveredInstant(expiresAtMs), timeZone)) -
		epochDay(isoDayIn(nowMs, timeZone)) +
		1
	);
}
