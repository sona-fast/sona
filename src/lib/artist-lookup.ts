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

/** Local artists a single match points at, by its index in `matches`. `pieces`
 * is how many images that artist already has — the ambiguous picker shows it,
 * because two artists can share a name and the count is what tells them apart.
 * Optional: a response from before the endpoint counted them carries none. */
export interface ArtistHit {
	matchIndex: number;
	artists: Array<{ id: number; name: string; pieces?: number }>;
}

export interface SourceClash {
	imageId: number;
	title: string;
	isVariant: boolean;
	parentImageId: number | null;
	variantCount: number;
	/** The piece the operator is being pointed at, for the thumbnail row. Null
	 * where the row carries none. */
	thumbnailUrl: string | null;
	artistName: string | null;
	uploadedAt: string | null;
	/** Pixel size of the piece, for the row's meta line. Null on a row saved
	 * before the columns were filled. */
	width: number | null;
	height: number | null;
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

/**
 * A variant tile's result line, in the two forms it is needed in: the one the
 * eye reads and the one the live region speaks. Both are built from the same
 * parts so they cannot drift, and the separator is added only between two
 * present parts — a match with no distance carries no band, and a dangling
 * middle dot would render as "handle on site · " and be spoken as "dot".
 *
 * A match can name no handle at all (a Twitter post the API returns without
 * one). "{handle} on {site}" promises a poster, so the empty case gets the
 * panel's own "Unknown poster on {site}" rather than something standing in for
 * a name.
 */
export function tileResultText(
	handle: string,
	site: LookupSite,
	band: MatchBand
): { line: string; spoken: string } {
	const result = handle.trim()
		? m.admin_lookup_tile_result({ handle, site: siteLabel(site) })
		: m.admin_lookup_match_unknown({ site: siteLabel(site) });
	const label = bandLabel(band);
	if (!label) return { line: result, spoken: result };
	return {
		line: m.admin_lookup_tile_result_band({ result, band: label }),
		spoken: m.admin_lookup_tile_result_spoken({ result, band: label })
	};
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
 * it. The one implementation — `$lib/server/fuzzysearch` re-exports this rather
 * than restating it. Possible and unknown-distance matches are excluded: a
 * loose match must not suggest an NSFW flag. */
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
 * already sorted by distance then site, so the first qualifier is the best.
 * Re-exported by `$lib/server/fuzzysearch`; this is the only copy. */
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
 * `$lib/server/fuzzysearch` re-exports this as `handleProfileUrl`, so the
 * new-artist prefill offers the same link the endpoint matched on. The handle
 * is third-party text, so it is percent-encoded: a slash or a '?' in it would
 * otherwise re-point the URL at another page. Weasyl and e621 have no column
 * yet (SONA-219) and resolve to null. */
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
	/** How many pieces this artist already has, when the endpoint counted them. */
	pieces?: number;
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

/**
 * The prefill a results state produces, given what the form currently holds.
 * Which match to fill from, which fields count as empty, and the clash skip are
 * one decision, and both pages were making it identically.
 */
export function prefillForResult(
	data: LookupResponse,
	current: { sourcePostUrl: string; commissionedAt: string }
): LookupFields {
	return prefillFields(
		pickPrefillMatch(data.matches),
		{
			sourcePostUrl: current.sourcePostUrl.trim() === '',
			commissionedAt: current.commissionedAt.trim() === ''
		},
		// The clash state deliberately leaves the URL empty: it already belongs to
		// another piece, and copying it would make two pieces claim one post.
		{ skipSourceUrl: !!data.sourceClash }
	);
}

/** What a lookup may seed into the inline "new artist" form. Absent means
 * "left alone", exactly like `LookupFields`. */
export interface NewArtistSeed {
	artistName?: string;
	profileUrl?: string;
}

/**
 * What to write into the inline new-artist form. Same rule as `prefillFields`:
 * only the fields the caller reports as empty are filled, because the operator
 * may have typed a name and pasted a profile URL before asking for the lookup
 * and neither is recoverable with a click. `linkable` is false for the sites
 * Sona holds no artist column for (SONA-219), which seed a name only.
 */
export function newArtistSeed(
	handle: string,
	site: LookupSite,
	linkable: boolean,
	empty: { artistName: boolean; profileUrl: boolean }
): NewArtistSeed {
	const clean = handle.trim().replace(/^@+/, '');
	if (!clean) return {};
	const seed: NewArtistSeed = {};
	if (empty.artistName) seed.artistName = clean;
	if (!linkable || !empty.profileUrl) return seed;
	const url = profileUrlFor(site, clean);
	if (url) seed.profileUrl = url;
	return seed;
}

/** Which sentence names what the seed actually wrote. */
export type SeedStatusKind = 'both' | 'name_only' | 'link_only' | 'none';

export function seedStatusKind(seed: NewArtistSeed): SeedStatusKind {
	const name = seed.artistName !== undefined;
	const link = seed.profileUrl !== undefined;
	if (name && link) return 'both';
	if (name) return 'name_only';
	if (link) return 'link_only';
	return 'none';
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

/**
 * Whether the file has already left the browser in this state. Every state but
 * `too_large` — refused client-side before anything is sent — means FuzzySearch
 * received a copy, so a private image's disclosure belongs on all of them, not
 * just on a result. `idle` and `searching` are not outcomes and carry no notice.
 */
export function lookupSentFile(state: LookupState): boolean {
	if (state.kind === 'idle' || state.kind === 'searching') return false;
	return !(state.kind === 'failed' && state.reason === 'too_large');
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
 * The one gate on a match's post URL. The endpoint builds these itself, so a
 * `javascript:` or `data:` URL can only arrive from something that is not the
 * endpoint — and both the panel row and the upload tile render it as an anchor
 * the operator clicks. Dropped here, once, rather than guarded at each link.
 */
function hasLinkableUrl(match: LookupMatch): boolean {
	return typeof match?.postUrl === 'string' && match.postUrl.startsWith('https://');
}

/**
 * The match list the panel actually renders: linkable URLs only, and one row
 * per post. The rows are keyed on site + siteId, so a post that came back twice
 * would crash the keyed each; the endpoint dedupes too, and this is the second
 * pass on the side that does the rendering.
 *
 * `indexMap` carries each kept match's old position, because `localArtists` and
 * `nameMatches` address matches by index into the list as it was sent.
 */
function usableMatches(raw: LookupMatch[]): { matches: LookupMatch[]; indexMap: Map<number, number> } {
	const matches: LookupMatch[] = [];
	const indexMap = new Map<number, number>();
	const kept = new Map<string, number>();
	raw.forEach((match, index) => {
		if (!hasLinkableUrl(match)) return;
		const key = `${match.site} ${match.siteId}`;
		const already = kept.get(key);
		if (already !== undefined) {
			// A duplicate's hits belong to the row that stayed.
			indexMap.set(index, already);
			return;
		}
		kept.set(key, matches.length);
		indexMap.set(index, matches.length);
		matches.push(match);
	});
	return { matches, indexMap };
}

/** Re-address artist hits onto the filtered match list, dropping the ones whose
 * match is not being rendered at all. */
function remapHits(hits: unknown, indexMap: Map<number, number>): ArtistHit[] {
	if (!Array.isArray(hits)) return [];
	return (hits as ArtistHit[]).flatMap((hit) => {
		const index = indexMap.get(hit?.matchIndex);
		return index === undefined ? [] : [{ ...hit, matchIndex: index }];
	});
}

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
	const raw = Array.isArray(data.matches) ? data.matches : [];
	const { matches, indexMap } = usableMatches(raw);
	// Same reasoning as the non-array branch above: something looked, something
	// answered, and the client refused to show it. Calling that "no matches" would
	// tell the operator their art is unindexed when it may well be posted.
	if (matches.length === 0 && raw.length > 0) return { kind: 'failed', reason: 'unavailable' };
	if (matches.length === 0) return { kind: 'no_match' };
	return {
		kind: 'results',
		applied: false,
		data: {
			enabled: true,
			matches,
			localArtists: remapHits(data.localArtists, indexMap),
			nameMatches: remapHits(data.nameMatches, indexMap),
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
