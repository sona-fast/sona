/**
 * Is a convention happening right now?
 *
 * `start_date` / `end_date` are bare calendar dates, not instants. "Anthrocon
 * runs Jul 31 to Aug 2" is a fact about local calendars, so the question has to
 * be asked in the convention's own timezone. Asking in UTC is wrong at both
 * ends: a UTC-7 event's closing day ends at 17:00 local, and its first day
 * starts the evening before.
 *
 * The reader's timezone is deliberately not used. It answers where the *reader*
 * is, not where the *event* is, so someone browsing from Berlin would disagree
 * with someone standing in the hallway. It is also unavailable server-side,
 * where this decision is made.
 */

/** A day either side, for rows with no zone. */
const GRACE_DAYS = 1;

/** The calendar date (YYYY-MM-DD) at `now`, as seen in `timeZone`.
 * Returns null if the zone is not one the runtime recognises. */
export function dateInZone(now: Date, timeZone: string): string | null {
	try {
		// en-CA formats as YYYY-MM-DD, which sorts and compares as a plain string
		// against the bare date columns.
		return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
	} catch {
		return null;
	}
}

/** An IANA zone name and nothing else. A stored zone is fed to Intl to decide
 *  whether a con is running now, so a junk value, from the cons.fyi feed or
 *  from a posted form, is rejected before it is stored.
 *
 *  Asking Intl rather than matching a shape, because Intl is what consumes the
 *  stored value: a shape check both accepts names Intl cannot resolve
 *  (`Foo/Bar`) and rejects single-segment names that are real zones (`UTC`,
 *  `Japan`). Those are the two answers that matter and a regex gets both wrong.
 *  Unresolvable zones are not fatal downstream — `dateInZone` catches and the
 *  window widens — but a con with a real zone should take the exact path. */
export function ianaZone(value: unknown): string | undefined {
	if (typeof value !== 'string' || value === '') return undefined;
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone: value });
		return value;
	} catch {
		return undefined;
	}
}

/** The zones the admin forms offer, sorted. Built once on the server and sent
 *  with the page, so the server pass and hydration render the same options
 *  whatever the browser's own list holds. UTC is added because V8 leaves it
 *  out of the list while still accepting it. */
export function zoneChoices(): string[] {
	let zones: string[] = [];
	try {
		zones = Intl.supportedValuesOf('timeZone');
	} catch {
		// A runtime without the list still gets UTC; a stored zone keeps
		// showing through the row's own option.
	}
	return [...new Set([...zones, 'UTC'])].sort();
}

export interface ZoneGroup {
	/** The zone's first segment ('America'), or null for a zone with none ('UTC'). */
	region: string | null;
	zones: { value: string; label: string }[];
}

/** Zones grouped by region for a select's optgroups, each labelled by the rest
 *  of its name ('America/Los_Angeles' reads 'Los Angeles' under 'America'),
 *  so a narrow closed select shows the city rather than cutting it off.
 *  Keeps the order it is given. */
export function zoneGroups(zones: string[]): ZoneGroup[] {
	const groups: ZoneGroup[] = [];
	for (const value of zones) {
		const cut = value.indexOf('/');
		const region = cut === -1 ? null : value.slice(0, cut);
		const label = (cut === -1 ? value : value.slice(cut + 1)).replaceAll('_', ' ').replaceAll('/', ' / ');
		let group = groups.find((g) => g.region === region);
		if (!group) groups.push((group = { region, zones: [] }));
		group.zones.push({ value, label });
	}
	return groups;
}

/** Shift a bare YYYY-MM-DD by whole days. Used only for the no-zone margin. */
function shiftDate(date: string, days: number): string {
	const ms = Date.parse(`${date}T00:00:00Z`);
	if (Number.isNaN(ms)) return date;
	return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

export interface ConventionWindow {
	startDate: string;
	endDate?: string | null;
	/** IANA zone, or null for a manual entry left unset and rows predating the column. */
	timezone?: string | null;
}

/**
 * Whether `now` falls inside the convention, inclusive of the first and last day.
 *
 * With a zone, the comparison is exact. Without one (manual entries left unset, rows created
 * before the column existed, or an unrecognised zone string) it falls back to UTC
 * and widens the window by a day at each end. That errs toward showing the state:
 * a banner that appears a few hours early is a much smaller failure than one that
 * goes dark while the operator is still at the event, which is the bug this
 * whole thing exists to fix.
 *
 * The grace is deliberately symmetric, and the back edge is the accepted cost: a
 * zoneless row can keep claiming "here now" for up to a day after its end date.
 * Trimming that side would drop the banner at 17:00 local on the closing day of a
 * zoneless western-zone con, which is exactly the failure above. Rows synced from
 * cons.fyi carry a real zone and take the exact path, so this only ever applies to
 * hand-entered rows with no zone picked, which admin can set, and pre-migration
 * rows, which a sync heals.
 */
export function isConventionRunning(con: ConventionWindow, now: Date): boolean {
	const end = con.endDate || con.startDate;

	const zoned = con.timezone ? dateInZone(now, con.timezone) : null;
	if (zoned) return zoned >= con.startDate && zoned <= end;

	const utcToday = now.toISOString().slice(0, 10);
	return utcToday >= shiftDate(con.startDate, -GRACE_DAYS) && utcToday <= shiftDate(end, GRACE_DAYS);
}

/** True when the convention should drive the live "here now" state: running, and
 * confirmed rather than a maybe. A convention the operator is only considering
 * must never assert that they are present. */
export function isLiveNow(
	con: ConventionWindow & { status?: string | null },
	now: Date
): boolean {
	return con.status === 'confirmed' && isConventionRunning(con, now);
}

/**
 * Whether the convention is over, asked in its own zone.
 *
 * Needed because the upcoming list is selected in SQL against a UTC date, which
 * drops a convention whose final day is still running further west. The query
 * therefore takes a day of slack and this decides what actually still counts as
 * upcoming.
 */
export function hasEnded(con: ConventionWindow, now: Date): boolean {
	const end = con.endDate || con.startDate;
	const zoned = con.timezone ? dateInZone(now, con.timezone) : null;
	if (zoned) return zoned > end;
	return now.toISOString().slice(0, 10) > shiftDate(end, GRACE_DAYS);
}

/** The UTC date to select the upcoming list from: a day behind today, so a
 * convention still running in a western zone survives the SQL filter and can be
 * judged properly by isLiveNow / hasEnded. */
export function upcomingCutoff(now: Date): string {
	return shiftDate(now.toISOString().slice(0, 10), -GRACE_DAYS);
}
