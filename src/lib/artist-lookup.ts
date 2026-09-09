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

/** Why a lookup did not produce matches. `signed_out`, `no_key` and `gone` are
 * this file's own: the admin gate answers an expired session with a plain-text
 * 401, the endpoint answers a removed key with enabled:false, and it answers an
 * image that is no longer in the library with a shaped 404 that names no
 * `error`. None of the three is a FuzzySearch failure, and each carries a
 * different remedy from every one below. */
export type LookupFailReason =
	| 'key_refused'
	| 'rate_limited'
	| 'too_large'
	| 'invalid_image'
	| 'unavailable'
	| 'signed_out'
	| 'no_key'
	| 'gone';

export type LookupState =
	| { kind: 'idle' }
	| { kind: 'searching' }
	| { kind: 'results'; data: LookupResponse }
	| { kind: 'no_match' }
	// `sent` records whether the file left the browser, which the reason cannot:
	// too_large and invalid_image each arise both from a gate that runs before
	// anything is forwarded and from FuzzySearch answering 413/400 after the file
	// was sent. The client knows its own refusals; for the rest it reads the
	// endpoint's `forwarded` field, which is the only thing that can tell an
	// endpoint gate apart from FuzzySearch answering the same way.
	| { kind: 'failed'; reason: LookupFailReason; sent: boolean };

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

/** Lenient to strict. The one list of ratings anything reads: the two
 * comparators and the endpoint's parse each held a copy, so a new rating had to
 * be added in three places to agree. */
export const RATING_ORDER: readonly LookupRating[] = ['general', 'mature', 'adult'];

/** The strictest rating across the confident matches, with the sites carrying
 * it. The one implementation — `$lib/server/fuzzysearch` re-exports this rather
 * than restating it. Possible and unknown-distance matches are excluded: a
 * loose match must not suggest an NSFW flag. */
export function strictestRating(
	matches: LookupMatch[]
): { rating: LookupRating; sites: LookupSite[] } | null {
	const confident = matches.filter((x) => x.band === 'exact' || x.band === 'strong');
	let best: LookupRating | null = null;
	for (const match of confident) {
		if (!match.rating) continue;
		if (best === null || RATING_ORDER.indexOf(match.rating) > RATING_ORDER.indexOf(best))
			best = match.rating;
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

/**
 * The confident match whose local-artist hit produced this candidate. The
 * candidates are unioned across every confident match, so the match that named
 * one of them is not necessarily the prefill match — and a line that pairs the
 * prefill match's handle with a candidate's name can read "alice is already in
 * your list as Bob". Null when no hit names the artist.
 */
export function matchForArtist(data: LookupResponse, artistId: number): LookupMatch | null {
	return (
		data.matches.find((match, index) => {
			if (match.band !== 'exact' && match.band !== 'strong') return false;
			const hit = data.localArtists.find((h) => h.matchIndex === index);
			return (hit?.artists ?? []).some((a) => a.id === artistId);
		}) ?? null
	);
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
	// A match that names no poster is nothing to add: "{handle} isn't in your
	// artist list yet" and "Add {handle} as a new artist" would both interpolate
	// an empty handle. The result row already says "Unknown poster on {site}".
	// Checked here rather than above, because the candidates are unioned across
	// every confident match — a handle-less prefill match can sit above one that
	// does name a local artist, and that offer is still good.
	if (!matchHandle(match)) return 'none';
	return LINKABLE_SITES.includes(match.site) ? 'new' : 'unlinked';
}

/**
 * The result as it stands once the operator has created an artist from it. The
 * new artist is recorded as a local hit on the prefill match — the one whose
 * handle seeded the dialog — which is what moves the outcome from 'new' to
 * 'existing'.
 *
 * Without it the panel keeps offering "Add {handle} as a new artist" for an
 * artist that now exists, and the second click creates a duplicate row:
 * POST /api/artists enforces no name uniqueness on a non-registry create, so
 * nothing downstream refuses it and the operator is left merging two artists by
 * hand. `pieces` is 0 because a just-created artist has none yet.
 */
export function withCreatedArtist(
	data: LookupResponse,
	artist: { id: number; name: string }
): LookupResponse {
	const matchIndex = data.matches.findIndex((x) => x.band === 'exact' || x.band === 'strong');
	if (matchIndex === -1) return data;
	const hit = { id: artist.id, name: artist.name, pieces: 0 };
	const existing = data.localArtists.find((h) => h.matchIndex === matchIndex);
	if (!existing) {
		return { ...data, localArtists: [...data.localArtists, { matchIndex, artists: [hit] }] };
	}
	if (existing.artists.some((a) => a.id === artist.id)) return data;
	return {
		...data,
		localArtists: data.localArtists.map((h) =>
			h.matchIndex === matchIndex ? { ...h, artists: [...h.artists, hit] } : h
		)
	};
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

/**
 * Which of the fields a lookup filled the operator has typed over since. The
 * record of what was filled never changes — this is the separate, mutable half
 * of it, and a field the lookup never filled cannot appear here at all.
 */
export interface SeedEdited {
	artistName?: boolean;
	profileUrl?: boolean;
}

/** Which sentence names what the seed actually wrote. */
export type SeedStatusKind = 'both' | 'name_only' | 'link_only' | 'none';

/** Only the fields still attributable to the lookup are named: a seeded field
 * the operator typed over is theirs now, and neither sentence half claims it.
 * `name_only` and `link_only` say nothing about the other field, so they hold
 * whether it was never seeded or seeded and then edited. */
export function seedStatusKind(seed: NewArtistSeed, edited: SeedEdited = {}): SeedStatusKind {
	const name = seed.artistName !== undefined && !edited.artistName;
	const link = seed.profileUrl !== undefined && !edited.profileUrl;
	if (name && link) return 'both';
	if (name) return 'name_only';
	if (link) return 'link_only';
	return 'none';
}

/** The two form fields' half of `SeedEdited`. */
export interface LookupEdited {
	sourcePostUrl?: boolean;
	commissionedAt?: boolean;
}

/** Which sentence describes what the prefill actually did. */
export type StatusLineKind =
	| 'both'
	| 'url_only'
	| 'date_only'
	| 'url_kept'
	| 'date_kept'
	| 'clash'
	| 'clash_kept'
	| 'none';

/**
 * The sentence names only the fields still attributable to the lookup, and
 * asserts nothing about one the operator has edited since. `url_only` says the
 * date was "left as it was", which is true of a date the lookup never filled
 * and false of one it filled and the operator then changed — that case gets
 * `url_kept`, which claims the URL and stays silent about the date. `date_kept`
 * is the mirror.
 *
 * The clash pair follows the same rule for the URL. `prefillForResult` skips the
 * URL on any clash, whatever the field holds, so "left the source post URL
 * empty" is true only of a field that WAS empty. `urlHeld` says it is not, and
 * picks `clash_kept`, which claims the date and says the URL was not filled
 * without claiming it is empty.
 */
export function statusLineKind(
	filled: LookupFields,
	options: { clash?: boolean; edited?: LookupEdited; urlHeld?: boolean } = {}
): StatusLineKind {
	const edited = options.edited ?? {};
	const urlFilled = filled.sourcePostUrl !== undefined;
	const dateFilled = filled.commissionedAt !== undefined;
	const url = urlFilled && !edited.sourcePostUrl;
	const date = dateFilled && !edited.commissionedAt;
	if (options.clash) {
		if (!date) return 'none';
		return options.urlHeld ? 'clash_kept' : 'clash';
	}
	if (url && date) return 'both';
	if (url) return dateFilled ? 'url_kept' : 'url_only';
	if (date) return urlFilled ? 'date_kept' : 'date_only';
	return 'none';
}

/**
 * Whether FuzzySearch has a copy of the file in this state, which is what the
 * private-image disclosure claims. A result and a no-match both mean it does.
 * A failure is read off its `sent` flag rather than its reason: `too_large`
 * comes from the client-side size check AND from FuzzySearch answering 413,
 * and `invalid_image` from the endpoint's own type gate AND from FuzzySearch
 * answering 400 — the reason alone cannot tell the two apart. `idle` and
 * `searching` are not outcomes and carry no notice.
 */
export function lookupSentFile(state: LookupState): boolean {
	if (state.kind === 'idle' || state.kind === 'searching') return false;
	return state.kind !== 'failed' || state.sent;
}

/** Body shapes the endpoint answers with. */
interface FailureBody {
	enabled?: boolean;
	error?: string;
	/** Whether the endpoint had already handed the bytes to FuzzySearch when it
	 * failed. Its own gates answer too_large and invalid_image with the same
	 * reasons FuzzySearch's 413/400 carry, so only the endpoint knows. */
	forwarded?: boolean;
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

/** The stricter of two ratings, either of which may be unknown. RATING_ORDER
 * runs lenient to strict. */
function stricterRating(a: LookupRating | null, b: LookupRating | null): LookupRating | null {
	if (a === null) return b;
	if (b === null) return a;
	return RATING_ORDER.indexOf(a) >= RATING_ORDER.indexOf(b) ? a : b;
}

/** The identity of a post: its site and its id there. The server's dedupe, the
 * client's, and the panel's keyed each built it their own way. The separator is
 * a character neither part can hold, so no pair of a site and an id collides
 * with another pair. */
export function matchKey(match: Pick<LookupMatch, 'site' | 'siteId'>): string {
	return `${match.site}\u0000${match.siteId}`;
}

/**
 * Fold a duplicate of the same post into the row being kept. Dropping it
 * instead threw away whatever only the duplicate knew: a Twitter copy with an
 * empty artists array sorts ahead of its twin on an equal distance, and the
 * survivor was then a handle-less `/i/status/` URL — the row read as an unknown
 * poster, the offer to add the artist went with it, and no stored
 * `twitter.com/{handle}/status/{id}` clashed with it.
 *
 * The kept row already holds the closest distance and the band that follows
 * from it, because both callers fold after the sort. The handles union, the
 * rating goes to the stricter of the two, and the date comes from whichever row
 * has one. The post URL follows the handle it names: every row's URL was built
 * from its own handles, so the twin's URL is what a rebuild from the merged
 * handles would produce when the kept row had none.
 *
 * Both the endpoint's dedupe and the panel's second pass run this — the two
 * used to be one merge and one silent drop, which disagreed about what a row
 * said.
 */
export function mergeSamePost(kept: LookupMatch, duplicate: LookupMatch): LookupMatch {
	const handles = [...kept.handles];
	for (const handle of duplicate.handles) {
		if (!handles.includes(handle)) handles.push(handle);
	}
	return {
		...kept,
		handles,
		rating: stricterRating(kept.rating, duplicate.rating),
		postedAt: kept.postedAt ?? duplicate.postedAt,
		postUrl: kept.handles.length === 0 ? duplicate.postUrl : kept.postUrl
	};
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
		const key = matchKey(match);
		const already = kept.get(key);
		if (already !== undefined) {
			// A duplicate's hits belong to the row that stayed, and so does whatever
			// only the duplicate knew.
			matches[already] = mergeSamePost(matches[already], match);
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
 * match is not being rendered at all. Two hits can land on one index once a
 * duplicate post folds into the row that stayed, and the readers here look a
 * hit up with `.find` — so the lists are unioned rather than left as a second
 * entry nothing reads. */
function remapHits(hits: unknown, indexMap: Map<number, number>): ArtistHit[] {
	if (!Array.isArray(hits)) return [];
	const merged = new Map<number, ArtistHit>();
	for (const hit of hits as ArtistHit[]) {
		const index = indexMap.get(hit?.matchIndex);
		if (index === undefined) continue;
		const already = merged.get(index);
		if (!already) {
			merged.set(index, { ...hit, matchIndex: index, artists: [...(hit.artists ?? [])] });
			continue;
		}
		for (const artist of hit.artists ?? []) {
			if (!already.artists.some((a) => a.id === artist.id)) already.artists.push(artist);
		}
	}
	return [...merged.values()];
}

/** What both pages log when applying a finished lookup throws. A constant, so
 * the line is the same on either page and carries nothing from the result. */
export const LOOKUP_RESULT_THREW = 'artist lookup: applying the result threw';

/**
 * Turn a response into a state. Mapped by the body's `error` field rather than
 * by status: the admin gate answers an expired session with its own plain-text
 * 401, and a status-keyed map would read that as a refused key and then throw
 * in `res.json()`. The content type is checked before anything is parsed.
 */
export async function stateFromResponse(res: Response): Promise<LookupState> {
	if (res.status === 401 || res.status === 403) return { kind: 'failed', reason: 'signed_out', sent: false };
	const contentType = res.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().includes('application/json')) {
		return { kind: 'failed', reason: 'unavailable', sent: true };
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: 'failed', reason: 'unavailable', sent: true };
	}
	if (!body || typeof body !== 'object') return { kind: 'failed', reason: 'unavailable', sent: true };

	if (!res.ok) {
		const failed = body as FailureBody;
		// The row went away between the page load and the click: the endpoint's
		// shaped 404 carries a message and no `error`, so the generic mapping below
		// would read it as an outage and say FuzzySearch didn't answer — which was
		// never asked. Client-side only: 'gone' is not in FAIL_REASONS because the
		// endpoint never sends it as an `error` value, and a 404 that DOES name one
		// keeps that reason. Nothing was forwarded, so the remedy is a reload.
		if (res.status === 404 && failed.error === undefined) {
			return { kind: 'failed', reason: 'gone', sent: false };
		}
		const known = FAIL_REASONS.find((r) => r === failed.error);
		// The endpoint says which side refused; a body without the field is one
		// this client cannot date, so the disclosure errs toward saying it went.
		return {
			kind: 'failed',
			reason: known ?? 'unavailable',
			sent: failed.forwarded !== false
		};
	}

	const data = body as Partial<LookupResponse>;
	// The key went away between the page load and the click. Its own reason, not
	// the generic outage: FuzzySearch was never contacted, and the remedy is a key
	// in Settings rather than a retry. The endpoint answers this before it reads
	// the body — it carries forwarded: false, and there is no path to this shape
	// that forwarded anything — so `sent` is false.
	if (data.enabled === false) return { kind: 'failed', reason: 'no_key', sent: false };
	const raw = Array.isArray(data.matches) ? data.matches : [];
	const { matches, indexMap } = usableMatches(raw);
	// Same reasoning as the non-array branch above: something looked, something
	// answered, and the client refused to show it. Calling that "no matches" would
	// tell the operator their art is unindexed when it may well be posted.
	if (matches.length === 0 && raw.length > 0) return { kind: 'failed', reason: 'unavailable', sent: true };
	if (matches.length === 0) return { kind: 'no_match' };
	return {
		kind: 'results',
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
		if (body.file.size > LOOKUP_MAX_BYTES) return { kind: 'failed', reason: 'too_large', sent: false };
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
		// The request was already on its way (a dropped connection, or the
		// operator's Cancel), so the disclosure errs toward saying the file went.
		return { kind: 'failed', reason: 'unavailable', sent: true };
	}
	return await stateFromResponse(res);
}
