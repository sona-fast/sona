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

export interface FeatureStamp {
	kind: FeatureKind;
	href: string;
	/** The numbers the stamp's lines template, in line order. Empty for About. */
	counts: number[];
}

export interface LiveStamp {
	name: string;
	location: string | null;
	/** The last day, as a bare YYYY-MM-DD date. */
	until: string;
	href: string;
}

export type ConventionStamp =
	| { kind: 'next'; name: string; startDate: string; href: string }
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

/** The gallery's fursuit view, filtered to one event. The same URL the
 *  gallery's own event filter produces, so the stamp lands on that view. */
export function fursuitEventHref(event: string): string {
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
 */
export function pastEventStamps(photos: PassportPhoto[]): ConventionStamp[] {
	const byEvent = new Map<string, { photos: number; latest: string | null }>();
	for (const photo of photos) {
		const event = photo.event?.trim();
		if (!event) continue;
		const date = photo.takenAt && /^\d{4}-\d{2}/.test(photo.takenAt) ? photo.takenAt.slice(0, 10) : null;
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
 * `aboutExtras` is whether /about has something the passport doesn't already
 * show besides conventions: a social link or any /art sona detail.
 */
export function buildStamps(input: {
	counts: PassportCounts;
	conventions: PassportConvention[];
	photos: PassportPhoto[];
	aboutExtras: boolean;
	now: Date;
}): PassportStamps {
	const { counts, now } = input;
	const confirmed = input.conventions
		.filter((c) => c.status === 'confirmed')
		.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));

	const liveRow = confirmed.find((c) => isLiveNow(c, now)) ?? null;
	const nextRow = confirmed.find((c) => c.id !== liveRow?.id && !hasEnded(c, now)) ?? null;

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
	if (input.aboutExtras || liveRow || nextRow) features.push({ kind: 'about', href: '/about', counts: [] });

	const conventions: ConventionStamp[] = [];
	if (nextRow) conventions.push({ kind: 'next', name: nextRow.name, startDate: nextRow.startDate, href: '/connect' });
	conventions.push(...pastEventStamps(input.photos));

	return {
		live: liveRow
			? {
					name: liveRow.name,
					location: liveRow.location?.trim() || null,
					until: liveRow.endDate || liveRow.startDate,
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
