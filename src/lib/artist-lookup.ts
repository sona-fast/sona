// Client-side half of "Look up artist" (SONA-156): the wire shape of
// POST /api/admin/artist-lookup, the state machine the upload and edit panels
// run on, and the pure helpers both pages share.
//
// Deliberately free of any `$lib/server` import. The endpoint's types live in
// `$lib/server/fuzzysearch`, which must never reach a browser bundle, so the
// wire shape is restated here and pinned against the server's version by
// `artist-lookup.test.ts` (a node test may import both).

import * as m from '$lib/paraglide/messages';

export type LookupSite = 'FurAffinity' | 'Weasyl' | 'e621' | 'Twitter';
export type LookupRating = 'general' | 'mature' | 'adult';
/** 0 → exact, 1-2 → strong, 3-7 → possible, unknown distance → null. */
export type MatchBand = 'exact' | 'strong' | 'possible' | null;

export interface LookupMatch {
	site: LookupSite;
	siteId: string;
	handles: string[];
	distance: number | null;
	band: MatchBand;
	postedAt: string | null;
	rating: LookupRating | null;
	postUrl: string;
}

/** Local artists a single match points at, by its index in `matches`. */
export interface ArtistHit {
	matchIndex: number;
	artists: Array<{ id: number; name: string }>;
}

export interface SourceClash {
	imageId: number;
	title: string;
	isVariant: boolean;
	parentImageId: number | null;
	variantCount: number;
}

export interface LookupResponse {
	enabled: boolean;
	matches: LookupMatch[];
	localArtists: ArtistHit[];
	nameMatches: ArtistHit[];
	sourceClash: SourceClash | null;
}

/** Why a lookup did not produce matches. `signed_out` is this file's own: the
 * admin gate answers an expired session with a plain-text 401, which is a
 * different remedy from every FuzzySearch failure below. */
export type LookupFailReason =
	| 'key_refused'
	| 'rate_limited'
	| 'too_large'
	| 'invalid_image'
	| 'unavailable'
	| 'signed_out';

export type LookupState =
	| { kind: 'idle' }
	| { kind: 'searching' }
	| { kind: 'results'; data: LookupResponse; applied: boolean }
	| { kind: 'no_match' }
	| { kind: 'failed'; reason: LookupFailReason };

/** The cap the endpoint enforces (MAX_REMOTE_BUFFER_BYTES, 10 MiB). Restated
 * here so an oversized file is refused before it is uploaded a second time;
 * `artist-lookup.test.ts` pins the two together. */
export const LOOKUP_MAX_BYTES = 10 * 1024 * 1024;

/** The sites Sona holds an artist column for. A match on any other site can be
 * shown, but never linked to a local artist (SONA-219). */
const LINKABLE_SITES: readonly LookupSite[] = ['FurAffinity', 'Twitter'];

/** Sites are proper nouns — spelled the same in every locale. */
export function siteLabel(site: LookupSite): string {
	return site;
}

/** How confident a match is, in words. A null distance carries no claim, so it
 * gets no label rather than a hedged one. */
export function bandLabel(band: MatchBand): string | null {
	switch (band) {
		case 'exact':
			return m.admin_lookup_band_exact();
		case 'strong':
			return m.admin_lookup_band_strong();
		case 'possible':
			return m.admin_lookup_band_possible();
		default:
			return null;
	}
}

export function ratingLabel(rating: LookupRating): string {
	switch (rating) {
		case 'general':
			return m.admin_lookup_rating_general();
		case 'mature':
			return m.admin_lookup_rating_mature();
		case 'adult':
			return m.admin_lookup_rating_adult();
	}
}

/** The outline tag that sits beside the NSFW checkbox. It never changes the
 * checkbox — it reports what the sites said and leaves the call to the
 * operator. `parent` spells the multi-tile shared box, where the rating came
 * from the parent tile rather than from the box's own image. */
export function ratingTag(
	strictest: { rating: LookupRating; sites: LookupSite[] } | null,
	options: { parent?: boolean } = {}
): string | null {
	if (!strictest || strictest.sites.length === 0) return null;
	const params = {
		rating: ratingLabel(strictest.rating),
		sites: strictest.sites.map(siteLabel).join(', ')
	};
	return options.parent ? m.admin_lookup_rating_tag_parent(params) : m.admin_lookup_rating_tag(params);
}

/** The strictest rating across the confident matches, with the sites carrying
 * it. Mirrors `strictestRating` on the server so a tile can rate itself from a
 * response the endpoint already normalized. Possible and unknown-distance
 * matches are excluded: a loose match must not suggest an NSFW flag. */
export function strictestRating(
	matches: LookupMatch[]
): { rating: LookupRating; sites: LookupSite[] } | null {
	const order: LookupRating[] = ['general', 'mature', 'adult'];
	const confident = matches.filter((x) => x.band === 'exact' || x.band === 'strong');
	let best: LookupRating | null = null;
	for (const match of confident) {
		if (!match.rating) continue;
		if (best === null || order.indexOf(match.rating) > order.indexOf(best)) best = match.rating;
	}
	if (!best) return null;
	const sites: LookupSite[] = [];
	for (const match of confident) {
		if (match.rating === best && !sites.includes(match.site)) sites.push(match.site);
	}
	return { rating: best, sites };
}

/** The match the form is filled from: the closest confident one. The endpoint
 * already sorted by distance then site, so the first qualifier is the best. */
export function pickPrefillMatch(matches: LookupMatch[]): LookupMatch | null {
	return matches.find((x) => x.band === 'exact' || x.band === 'strong') ?? null;
}

/** `<input type="date">` wants a bare calendar day. A timestamp that isn't one
 * comes back null rather than as a date the operator would have to correct. */
export function postDateToInput(iso: string | null | undefined): string | null {
	if (!iso) return null;
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
	if (!match) return null;
	const parsed = new Date(match[1] + 'T00:00:00Z');
	return Number.isNaN(parsed.getTime()) ? null : match[1];
}

/** The first handle a match names, without its '@'. */
export function matchHandle(match: LookupMatch | null): string {
	return (match?.handles[0] ?? '').trim().replace(/^@+/, '');
}

/** Every handle a match names, for the "{handles} on {site}" line. */
export function matchHandles(match: LookupMatch): string {
	return match.handles
		.map((h) => h.trim().replace(/^@+/, ''))
		.filter(Boolean)
		.join(', ');
}

/** Canonical profile URL for a handle, for the sites Sona holds a column for.
 * Mirrors `handleProfileUrl` on the server (pinned by the unit test) so the
 * new-artist prefill offers the same link the endpoint would have matched on.
 * Weasyl and e621 have no column yet (SONA-219) and resolve to null. */
export function profileUrlFor(site: LookupSite, handle: string): string | null {
	const clean = handle.trim().replace(/^@+/, '');
	if (!clean) return null;
	const safe = encodeURIComponent(clean);
	if (site === 'FurAffinity') return `https://www.furaffinity.net/user/${safe}/`;
	if (site === 'Twitter') return `https://twitter.com/${safe}`;
	return null;
}

export interface ArtistChoice {
	id: number;
	name: string;
	site: LookupSite;
}

/**
 * Local artists any confident match points at, deduplicated by id. Union rather
 * than the prefill match alone: two sites can name two different artists Sona
 * already holds, and hiding the second one would silently pick for the operator.
 */
export function candidateArtists(data: LookupResponse): ArtistChoice[] {
	const seen = new Map<number, ArtistChoice>();
	data.matches.forEach((match, index) => {
		if (match.band !== 'exact' && match.band !== 'strong') return;
		const hit = data.localArtists.find((h) => h.matchIndex === index);
		for (const artist of hit?.artists ?? []) {
			if (!seen.has(artist.id)) seen.set(artist.id, { ...artist, site: match.site });
		}
	});
	return [...seen.values()];
}

/** The artists a name (not a handle) collision turned up for the prefill match.
 * Weaker evidence, so it prompts rather than links. */
export function nameMatchArtists(data: LookupResponse): Array<{ id: number; name: string }> {
	const match = pickPrefillMatch(data.matches);
	if (!match) return [];
	const index = data.matches.indexOf(match);
	return data.nameMatches.find((h) => h.matchIndex === index)?.artists ?? [];
}

export type LookupOutcome = 'existing' | 'ambiguous' | 'new' | 'unlinked' | 'none';

/** What the panel offers the operator, given what came back. */
export function resolveOutcome(data: LookupResponse): LookupOutcome {
	const match = pickPrefillMatch(data.matches);
	if (!match) return 'none';
	const candidates = candidateArtists(data);
	if (candidates.length >= 2) return 'ambiguous';
	if (candidates.length === 1) return 'existing';
	return LINKABLE_SITES.includes(match.site) ? 'new' : 'unlinked';
}

/** True when the ambiguity spans sites, which the copy names differently. */
export function isCrossSiteAmbiguity(data: LookupResponse): boolean {
	return new Set(candidateArtists(data).map((c) => c.site)).size > 1;
}

/** The two form fields a lookup can fill. Absent means "left alone". */
export interface LookupFields {
	sourcePostUrl?: string;
	commissionedAt?: string;
}

/**
 * What to write into the form. Only fields the caller reports as empty are
 * filled: a lookup is a suggestion, and overwriting something the operator
 * typed would be the one thing they cannot undo with a click. `skipSourceUrl`
 * is the clash case, where the post URL already belongs to another piece.
 */
export function prefillFields(
	match: LookupMatch | null,
	empty: { sourcePostUrl: boolean; commissionedAt: boolean },
	options: { skipSourceUrl?: boolean } = {}
): LookupFields {
	if (!match) return {};
	const fields: LookupFields = {};
	if (empty.sourcePostUrl && !options.skipSourceUrl && match.postUrl) {
		fields.sourcePostUrl = match.postUrl;
	}
	if (empty.commissionedAt) {
		const date = postDateToInput(match.postedAt);
		if (date) fields.commissionedAt = date;
	}
	return fields;
}

/** Which sentence describes what the prefill actually did. */
export type StatusLineKind = 'both' | 'url_only' | 'date_only' | 'clash' | 'none';

export function statusLineKind(
	filled: LookupFields,
	options: { clash?: boolean } = {}
): StatusLineKind {
	const url = filled.sourcePostUrl !== undefined;
	const date = filled.commissionedAt !== undefined;
	if (options.clash) return date ? 'clash' : 'none';
	if (url && date) return 'both';
	if (url) return 'url_only';
	if (date) return 'date_only';
	return 'none';
}

/** The sites named on the result rows, in order, for the "found on N sites"
 * eyebrow. */
export function matchedSites(matches: LookupMatch[]): LookupSite[] {
	const sites: LookupSite[] = [];
	for (const match of matches) if (!sites.includes(match.site)) sites.push(match.site);
	return sites;
}

/** Body shapes the endpoint answers with. */
interface FailureBody {
	enabled?: boolean;
	error?: string;
}

const FAIL_REASONS: readonly LookupFailReason[] = [
	'key_refused',
	'rate_limited',
	'too_large',
	'invalid_image',
	'unavailable'
];

/**
 * Turn a response into a state. Mapped by the body's `error` field rather than
 * by status: the admin gate answers an expired session with its own plain-text
 * 401, and a status-keyed map would read that as a refused key and then throw
 * in `res.json()`. The content type is checked before anything is parsed.
 */
export async function stateFromResponse(res: Response): Promise<LookupState> {
	if (res.status === 401 || res.status === 403) return { kind: 'failed', reason: 'signed_out' };
	const contentType = res.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().includes('application/json')) {
		return { kind: 'failed', reason: 'unavailable' };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: 'failed', reason: 'unavailable' };
	}
	if (!body || typeof body !== 'object') return { kind: 'failed', reason: 'unavailable' };

	if (!res.ok) {
		const reason = (body as FailureBody).error;
		const known = FAIL_REASONS.find((r) => r === reason);
		return { kind: 'failed', reason: known ?? 'unavailable' };
	}

	const data = body as Partial<LookupResponse>;
	// The key went away between the page load and the click. Nothing to show and
	// nothing the panel can offer, so it reads as an outage.
	if (data.enabled === false) return { kind: 'failed', reason: 'unavailable' };
	const matches = Array.isArray(data.matches) ? data.matches : [];
	if (matches.length === 0) return { kind: 'no_match' };
	return {
		kind: 'results',
		applied: false,
		data: {
			enabled: true,
			matches,
			localArtists: Array.isArray(data.localArtists) ? data.localArtists : [],
			nameMatches: Array.isArray(data.nameMatches) ? data.nameMatches : [],
			sourceClash: data.sourceClash ?? null
		}
	};
}

/** POST a file (upload page) or a stored image id (edit page) and resolve to a
 * state. The oversized check is client-side so a file the endpoint would refuse
 * is never sent at all. */
export async function runLookup(
	body: { file: File } | { imageId: number },
	options: { signal?: AbortSignal; fetchFn?: typeof fetch } = {}
): Promise<LookupState> {
	const fetchFn = options.fetchFn ?? fetch;
	let init: RequestInit;
	if ('file' in body) {
		if (body.file.size > LOOKUP_MAX_BYTES) return { kind: 'failed', reason: 'too_large' };
		const form = new FormData();
		form.append('file', body.file);
		init = { method: 'POST', body: form };
	} else {
		init = {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ imageId: body.imageId })
		};
	}
	let res: Response;
	try {
		res = await fetchFn('/api/admin/artist-lookup', { ...init, signal: options.signal });
	} catch {
		return { kind: 'failed', reason: 'unavailable' };
	}
	return await stateFromResponse(res);
}
