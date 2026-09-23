// The passport homepage's stamp assembly and machine-readable line. Pure and
// client-safe: the loader (src/lib/server/passport.ts) feeds it rows it has
// already read, and the unit tests feed it fixtures, so which stamp renders for
// which data is decided in exactly one place.

import { isLiveNow, hasEnded, type ConventionWindow } from '$lib/convention-window';

/** How many past-event stamps the page shows, newest first. */
export const MAX_PAST_STAMPS = 6;

/**
 * Counts behind the feature stamps. `null` means "unknown" (the read stalled,
 * failed, or the feature is off), which hides the stamp exactly like zero
 * does: a stalled count must never render as "0 pieces".
 */
export interface PassportCounts {
	pieces: number | null;
	artists: number | null;
	photos: number | null;
	photographers: number | null;
	stickers: number | null;
	packs: number | null;
	avatars: number | null;
	collections: number | null;
}

export type FeatureKind = 'gallery' | 'fursuit' | 'stickers' | 'vr' | 'collections' | 'about';

/** What /about holds beyond the passport, which picks the About stamp's line. */
export type AboutLine = 'links' | 'conventions' | 'both';

export interface FeatureStamp {
	kind: FeatureKind;
	href: string;
	/** The numbers the stamp's lines template, in line order. Empty for About. */
	counts: number[];
	/** Set on the About stamp only. */
	about?: AboutLine;
}

export interface LiveStamp {
	name: string;
	location: string | null;
	/** The last day, as a bare YYYY-MM-DD date; null when the stored date is not
	 *  one, so the page drops the date rather than failing to format it. */
	until: string | null;
	href: string;
}

export type ConventionStamp =
	/** startDate is null when the stored date is not a calendar date. */
	| { kind: 'next'; name: string; startDate: string | null; href: string }
	| { kind: 'past'; name: string; month: string | null; photos: number; href: string };

export interface PassportStamps {
	live: LiveStamp | null;
	features: FeatureStamp[];
	conventions: ConventionStamp[];
}

export interface PassportConvention extends ConventionWindow {
	id: number;
	name: string;
	location: string | null;
	status: string;
}

/** The two fields of a displayable fursuit photo the event stamps read. */
export interface PassportPhoto {
	event?: string;
	takenAt?: string;
}

const positive = (n: number | null): n is number => n !== null && n > 0;

/**
 * A stored date as a strict YYYY-MM-DD or YYYY-MM naming a real day, else
 * null. Intl.DateTimeFormat throws on an Invalid Date, so a value like
 * "0000-00-00" or "2025-13-05" reaching the page would 500 the homepage during
 * SSR; treating it as missing drops the date line instead. The round trip
 * through toISOString catches an impossible day ("2026-02-30"), which Date
 * rolls over into the next month rather than rejecting.
 */
function calendarDate(value: string | null | undefined): string | null {
	if (!value || !/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(value)) return null;
	const date = new Date(`${value.length === 7 ? `${value}-01` : value}T00:00:00Z`);
	return date.toISOString().slice(0, value.length) === value ? value : null;
}

/** The gallery's fursuit view, filtered to one event. The same URL the
 *  gallery's own event filter produces, so the stamp lands on that view. */
function fursuitEventHref(event: string): string {
	return `/gallery?view=fursuit&event=${encodeURIComponent(event)}`;
}

/**
 * Past-event stamps, built from the fursuit photos' own `event` values.
 *
 * Deliberately NOT from past rows in the conventions table. /connect and
 * /about publish only upcoming and live conventions, so a stamp derived from
 * the table would publish a new record of where the operator has been. The
 * photos' event names are already public: the gallery's event filter and each
 * fursuit photo page show them. So a past convention with no photos produces
 * no stamp, and every stamp has somewhere to link.
 *
 * The month and the count come from the photos too: the month of the newest
 * dated photo, and the number of photos carrying that event. Newest first by
 * that date (undated events after the dated ones), capped at MAX_PAST_STAMPS.
 *
 * `exclude` holds every live convention's name: photos tagged during an event
 * must not add a past stamp for a convention that is running. Exact match, as
 * the gallery's event filter compares, and before the cap so it still fills.
 */
export function pastEventStamps(photos: PassportPhoto[], exclude?: ReadonlySet<string>): ConventionStamp[] {
	const byEvent = new Map<string, { photos: number; latest: string | null }>();
	for (const photo of photos) {
		// Grouped and linked by the stored value: the gallery's event filter
		// compares exactly, so a trimmed name would link to an empty view. trim()
		// only skips an event that is all whitespace.
		const event = photo.event;
		if (!event?.trim() || exclude?.has(event)) continue;
		// The date part of a timestamp ("2025-11-09T10:00:00Z" reads as its day).
		const date = calendarDate(photo.takenAt?.slice(0, 10));
		const entry = byEvent.get(event) ?? { photos: 0, latest: null };
		entry.photos++;
		if (date && (!entry.latest || date > entry.latest)) entry.latest = date;
		byEvent.set(event, entry);
	}
	return [...byEvent]
		.sort(([nameA, a], [nameB, b]) => {
			if (a.latest !== b.latest) {
				if (!a.latest) return 1;
				if (!b.latest) return -1;
				return a.latest < b.latest ? 1 : -1;
			}
			return nameA.localeCompare(nameB);
		})
		.slice(0, MAX_PAST_STAMPS)
		.map(([name, { photos: count, latest }]) => ({
			kind: 'past' as const,
			name,
			month: latest ? latest.slice(0, 7) : null,
			photos: count,
			href: fursuitEventHref(name)
		}));
}

/**
 * Every stamp the passport renders, in page order. A feature with no content
 * gets no stamp, so no line ever reads zero.
 *
 * Here now and Next read the conventions table, which /connect publishes
 * anyway: confirmed rows only (a maybe or considering row never asserts where
 * the operator will be), live decided by isLiveNow in the event's own zone, and
 * the live row left out of Next so it never shows twice. Past stamps come from
 * the fursuit photos, see pastEventStamps.
 *
 * `about` is what /about has that the passport doesn't already show: a social
 * link or a convention /about itself lists (any status, against today's UTC
 * date). Sona details (build, key features, colours, dos and don'ts) are not a
 * reason: they live on /art, not /about, and /art already has its own stamps
 * through the gallery and the ref sheet. Only that read decides the
 * conventions line, not the live or next row: on a live con's last evening in
 * its own zone, /about may already have dropped it. Which of them exist picks
 * the stamp's line.
 */
export function buildStamps(input: {
	counts: PassportCounts;
	conventions: PassportConvention[];
	photos: PassportPhoto[];
	about: { links: boolean; conventions: boolean };
	now: Date;
}): PassportStamps {
	const { counts, now } = input;
	// The loader's query already selects confirmed rows in start order; that is
	// an optimisation. This filter and sort are what decide, so the function is
	// right for any rows it is handed. An undated row sorts last.
	const startOf = (c: PassportConvention) => calendarDate(c.startDate) ?? '9999';
	const confirmed = input.conventions
		.filter((c) => c.status === 'confirmed')
		.sort((a, b) => (startOf(a) < startOf(b) ? -1 : startOf(a) > startOf(b) ? 1 : 0));

	const liveRows = confirmed.filter((c) => isLiveNow(c, now));
	const liveRow = liveRows[0] ?? null;
	const liveNames = new Set(liveRows.map((c) => c.name));
	// Not "not the live row": a second convention running at the same time is
	// live too, and must never read as Next.
	const nextRow = confirmed.find((c) => !isLiveNow(c, now) && !hasEnded(c, now)) ?? null;

	const features: FeatureStamp[] = [];
	if (positive(counts.pieces) && positive(counts.artists)) {
		features.push({ kind: 'gallery', href: '/gallery', counts: [counts.pieces, counts.artists] });
	}
	if (positive(counts.photos) && positive(counts.photographers)) {
		features.push({ kind: 'fursuit', href: '/gallery?view=fursuit', counts: [counts.photos, counts.photographers] });
	}
	if (positive(counts.stickers) && positive(counts.packs)) {
		features.push({ kind: 'stickers', href: '/stickers', counts: [counts.stickers, counts.packs] });
	}
	if (positive(counts.avatars)) features.push({ kind: 'vr', href: '/vr', counts: [counts.avatars] });
	if (positive(counts.collections)) {
		features.push({ kind: 'collections', href: '/collections', counts: [counts.collections] });
	}
	const links = input.about.links;
	const cons = input.about.conventions;
	if (links || cons) {
		const about: AboutLine = links && cons ? 'both' : links ? 'links' : 'conventions';
		features.push({ kind: 'about', href: '/about', counts: [], about });
	}

	const conventions: ConventionStamp[] = [];
	if (nextRow) {
		conventions.push({ kind: 'next', name: nextRow.name, startDate: calendarDate(nextRow.startDate), href: '/connect' });
	}
	conventions.push(...pastEventStamps(input.photos, liveNames));

	return {
		live: liveRow
			? {
					name: liveRow.name,
					location: liveRow.location?.trim() || null,
					until: calendarDate(liveRow.endDate || liveRow.startDate),
					href: '/connect'
				}
			: null,
		features,
		conventions
	};
}

export function hasAnyStamp(stamps: PassportStamps): boolean {
	return Boolean(stamps.live) || stamps.features.length > 0 || stamps.conventions.length > 0;
}

/** Width of each row of the machine-readable line, as on a real passport. */
export const MRZ_WIDTH = 44;

/** One field in machine-readable form: upper case, separators as '<', anything
 *  outside A-Z and 0-9 dropped ("Red fox" → "RED<FOX", "she/her" → "SHEHER"). */
export function mrzField(value: string): string {
	return value
		.normalize('NFKD')
		.toUpperCase()
		.replace(/[\s.\-_]+/g, '<')
		.replace(/[^A-Z0-9<]/g, '')
		.replace(/^<+|<+$/g, '');
}

const mrzRow = (text: string) => text.slice(0, MRZ_WIDTH).padEnd(MRZ_WIDTH, '<');

/**
 * The decorative two-row machine-readable line. Built from the host, name,
 * species, pronouns and year only, never from counts, so a fresh site never
 * shows a zero here. The second row falls back to the host when the other
 * three fields are all unset.
 */
export function machineLine(fields: {
	host: string;
	name: string;
	species: string;
	pronouns: string;
	since: string | null;
}): [string, string] {
	const host = mrzField(fields.host);
	const rest = [fields.species, fields.pronouns, fields.since ?? '']
		.map(mrzField)
		.filter(Boolean)
		.join('<<');
	return [mrzRow(`P<${host}<<${mrzField(fields.name)}`), mrzRow(rest || host)];
}
