// Server-only client for FuzzySearch (https://fuzzysearch.net), the reverse
// image search behind "Look up artist" (SONA-156).
//
// Server-only for two reasons: the API key must never reach the browser, and
// the operator's artwork leaves this app only from a place we control. Every
// call is operator-initiated — nothing here runs on a render path, and nothing
// is sent until the operator clicks.
//
// The response body is TREATED AS SECRET-ADJACENT: it is never logged, never
// stored, and never echoed anywhere but the normalized shape below. A 4xx body
// can carry the key back, and the match list is third-party data about the
// operator's own art.

import { bufferStream, MAX_REMOTE_BUFFER_BYTES } from './storage/buffer';
import { getRawSetting } from './settings';
import { normalizeHandle, socialsToHandles, type Platform } from './handle-normalize';
import type { Database } from './db';

type Env = App.Platform['env'];

/** site_settings keys. Raw rows, like the registry fork key: kept out of the
 * SiteSettings interface so the key never serializes to the browser. */
export const FUZZYSEARCH_API_KEY_SETTING = 'fuzzysearchApiKey';
/** `<iso date-time>|<key source>` for the last refusal from FuzzySearch, or ''
 * once a call succeeds. See `fuzzysearchRefusedMarker`. */
export const FUZZYSEARCH_KEY_REFUSED_SETTING = 'fuzzysearchKeyRefusedAt';

export const FUZZYSEARCH_ENDPOINT = 'https://api.fuzzysearch.net/v1/image';
/** Same 10 MiB bound every other third-party body gets (storage/buffer.ts). */
export const FUZZYSEARCH_MAX_BYTES = MAX_REMOTE_BUFFER_BYTES;
/** How much of a 4xx body the 400 branch reads before giving up on it: the
 * token it looks for sits in a short JSON error object, and nothing past 4 KiB
 * is evidence. */
export const FUZZYSEARCH_ERROR_BODY_BYTES = 4096;
/** How much of a 200 body is read: a match list runs to a few KB, so a MiB is
 * already generous, and past it the response is a broken or hostile upstream
 * rather than a search result. */
export const FUZZYSEARCH_RESPONSE_BYTES = 1024 * 1024;
export const FUZZYSEARCH_TIMEOUT_MS = 8000;
/** Hamming distance past which a match is noise rather than a lead. */
export const FUZZYSEARCH_MAX_DISTANCE = 7;

export type LookupSite = 'FurAffinity' | 'Weasyl' | 'e621' | 'Twitter';
export type LookupRating = 'general' | 'mature' | 'adult';
/** 0 → exact, 1-2 → strong, 3-7 → possible, unknown distance → null. */
export type MatchBand = 'exact' | 'strong' | 'possible' | null;

export interface LookupMatch {
	site: LookupSite;
	siteId: string;
	/** Raw handles as the source site knows them (not normalized). */
	handles: string[];
	distance: number | null;
	band: MatchBand;
	postedAt: string | null;
	rating: LookupRating | null;
	postUrl: string;
}

export type LookupFailure =
	| 'key_refused'
	| 'rate_limited'
	| 'too_large'
	| 'invalid_image'
	| 'unavailable';

export type LookupResult =
	| { ok: true; matches: LookupMatch[] }
	| { ok: false; reason: LookupFailure };

const SITES: readonly LookupSite[] = ['FurAffinity', 'Weasyl', 'e621', 'Twitter'];
const RATINGS: readonly LookupRating[] = ['general', 'mature', 'adult'];

/** Display order when distances tie: the sites whose matches are most likely to
 * name an artist we can link locally come first. */
const SITE_ORDER: Record<LookupSite, number> = {
	FurAffinity: 0,
	Twitter: 1,
	Weasyl: 2,
	e621: 3
};

/** Where the key in use came from: the deploy secret, or the admin settings. */
export type FuzzysearchKeySource = 'env' | 'stored';

/**
 * Resolve the FuzzySearch key: a deploy-time `FUZZYSEARCH_API_KEY` secret wins
 * and short-circuits the DB read, otherwise the D1 raw setting. Same precedence
 * as the registry fork key, so a fork can connect from the admin UI without a
 * deploy. Returns null when the integration is not configured. The source
 * travels with the key so a refusal can be recorded against the key it refused.
 */
export async function resolveFuzzysearchKey(
	db: Database,
	env: Env | undefined
): Promise<{ key: string; source: FuzzysearchKeySource } | null> {
	const fromEnv = env?.FUZZYSEARCH_API_KEY?.trim();
	if (fromEnv) return { key: fromEnv, source: 'env' };
	const stored = (await getRawSetting(db, FUZZYSEARCH_API_KEY_SETTING))?.trim();
	return stored ? { key: stored, source: 'stored' } : null;
}

/**
 * The value written to FUZZYSEARCH_KEY_REFUSED_SETTING: when the refusal
 * happened and WHICH key was refused. The source has to be stored alongside
 * the date because the settings card only offers a remedy for a key saved
 * there — without it, a refusal recorded while the deploy secret was in use
 * would later be shown against a stored key that was never refused.
 */
export function fuzzysearchRefusedMarker(
	source: FuzzysearchKeySource,
	at: Date = new Date()
): string {
	return `${at.toISOString()}|${source}`;
}

/** Read a refusal marker back. '' (the cleared value) and anything without a
 * date come back null; a value carrying no source reads as 'stored', the state
 * the settings card can act on. */
export function parseFuzzysearchRefusedMarker(
	raw: string | null | undefined
): { at: string; source: FuzzysearchKeySource } | null {
	const [at, source] = (raw ?? '').trim().split('|');
	if (!at) return null;
	return { at, source: source === 'env' ? 'env' : 'stored' };
}

/**
 * Masked record of a stored key for the settings card: exactly eight bullets
 * plus the last four characters, so the mask says nothing about the key's
 * length. The operator only needs to recognize which key is saved — the value
 * itself never leaves the server.
 */
export function fuzzysearchKeyDisplayRecord(key: string): string {
	const tail = key.length > 4 ? key.slice(-4) : '';
	return '•'.repeat(8) + tail;
}

/** Band for a distance, matching the wording the UI uses about confidence. */
export function distanceBand(distance: number | null): MatchBand {
	if (distance === null) return null;
	if (distance === 0) return 'exact';
	if (distance <= 2) return 'strong';
	return 'possible';
}

/** A handle as the rest of this file wants it: trimmed, with the '@' decoration
 * off. Handles arrive spelled either way, and one that was nothing but
 * decoration comes back empty for the caller to fall back on. */
function cleanHandle(handle: string): string {
	return handle.trim().replace(/^@+/, '');
}

/** Public post URL for a match, by site. Built here rather than trusted from
 * the response so a hostile payload cannot hand the operator an arbitrary link. */
export function postUrlFor(site: LookupSite, siteId: string, handles: string[]): string {
	const id = encodeURIComponent(siteId);
	switch (site) {
		case 'FurAffinity':
			return `https://www.furaffinity.net/view/${id}/`;
		case 'Weasyl':
			return `https://www.weasyl.com/submission/${id}`;
		case 'e621':
			return `https://e621.net/posts/${id}`;
		case 'Twitter': {
			// The '@' is not part of the path, and a handle that was nothing but
			// decoration falls through to the handle-less spelling.
			const handle = cleanHandle(handles[0] ?? '');
			// Without a handle Twitter still resolves the status through /i/.
			return handle
				? `https://twitter.com/${encodeURIComponent(handle)}/status/${id}`
				: `https://twitter.com/i/status/${id}`;
		}
	}
}

/** Canonical profile URL for a handle on a site we hold an artist column for.
 * Weasyl and e621 have no column yet (SONA-219), so they resolve to null. */
export function handleProfileUrl(site: LookupSite, handle: string): string | null {
	const h = cleanHandle(handle);
	if (!h) return null;
	// Percent-encoded like postUrlFor's ids: a handle is third-party text, and a
	// slash or a '?' in it would otherwise re-point the URL at another page.
	const safe = encodeURIComponent(h);
	if (site === 'FurAffinity') return `https://www.furaffinity.net/user/${safe}/`;
	if (site === 'Twitter') return `https://twitter.com/${safe}`;
	return null;
}

/** Hosts that are the same site under two names. Without folding these, an
 * operator who saved an `x.com` link gets no clash warning for the `twitter.com`
 * URL this client builds. A Map, not an object literal: a plain lookup answers
 * `constructor` and `__proto__` with an inherited member rather than a miss. */
const HOST_ALIASES = new Map<string, string>([
	['x.com', 'twitter.com'],
	['mobile.twitter.com', 'twitter.com'],
	['sfw.furaffinity.net', 'furaffinity.net']
]);

/** Hosts whose paths are case-insensitive, so `/View/12345` and `/view/12345`
 * are one post. Weasyl is here for the username in its permalinks: `/~User/` and
 * `/~user/` are the same artist, and what the fold below leaves is numeric. Left
 * alone elsewhere — most sites' paths are case-sensitive. */
const CASE_INSENSITIVE_PATH_HOSTS = new Set(['twitter.com', 'furaffinity.net', 'weasyl.com']);

/**
 * Normalize a source-post URL for equality checks: lowercase host, no scheme,
 * no `www.`, no query, no fragment, no trailing slash, and known host aliases
 * folded together. Comparing raw strings would miss `http` vs `https`, the
 * trailing slash FurAffinity adds, and `x.com` against `twitter.com`.
 */
export function normalizeSourceUrl(url: string | null | undefined): string {
	const raw = (url ?? '').trim();
	if (!raw) return '';
	let rest = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
	rest = rest.replace(/[?#].*$/, '');
	rest = rest.replace(/\/+$/, '');
	const slash = rest.indexOf('/');
	let host = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase().replace(/^www\./, '');
	host = HOST_ALIASES.get(host) ?? host;
	let path = slash === -1 ? '' : rest.slice(slash);
	if (CASE_INSENSITIVE_PATH_HOSTS.has(host)) path = path.toLowerCase();
	// A tweet is identified by its status id alone: `/kuttoya/status/160` and the
	// handle-less `/i/status/160` this client builds for a match with no artist
	// are the same post, so both reduce to the `/i/` spelling before comparison.
	// Anything after the id goes too, so the `/photo/1` permalink Twitter's own
	// UI hands out compares equal to the bare tweet.
	if (host === 'twitter.com') path = path.replace(/^\/[^/]+\/status\/(\d+).*$/, '/i/status/$1');
	// The same submission under each site's other spelling: FurAffinity's
	// full-size view (`/full/12345`) is the post this client builds as
	// `/view/12345`, and e621's old post path (`/post/show/160`) is today's
	// `/posts/160`. An operator who saved either gets no clash warning without
	// the fold. e621's old path also carried the tag string as a trailing
	// segment (`/post/show/160/canine`), and Weasyl hangs the title slug off the
	// submission path (`/submission/5150/some-title`) — both still the same post;
	// FurAffinity's stays anchored, since nothing follows the id there. Weasyl's
	// own permalink names the artist as well (`/~kuttoya/submissions/5150/title`),
	// and that is the submission this client builds as `/submission/5150`; a
	// `/submissions/5150` with no user segment is another page, so it stays put.
	if (host === 'furaffinity.net') path = path.replace(/^\/full\/(\d+)$/, '/view/$1');
	if (host === 'e621.net') path = path.replace(/^\/post\/show\/(\d+)(?:\/.*)?$/, '/posts/$1');
	if (host === 'weasyl.com')
		path = path
			.replace(/^\/submission\/(\d+)(?:\/.*)?$/, '/submission/$1')
			.replace(/^\/~[^/]+\/submissions\/(\d+)(?:\/.*)?$/, '/submission/$1');
	return host + path;
}

interface RawMatch {
	site?: unknown;
	site_id_str?: unknown;
	artists?: unknown;
	distance?: unknown;
	posted_at?: unknown;
	rating?: unknown;
}

function normalizeMatch(raw: RawMatch): LookupMatch | null {
	const site = SITES.find((s) => s === raw.site);
	// 'Unknown' (and anything else we have no post-URL shape for) is dropped:
	// a match we cannot link to is not a lead the operator can act on.
	if (!site) return null;
	const siteId = typeof raw.site_id_str === 'string' ? raw.site_id_str : '';
	if (!siteId) return null;

	const distance =
		typeof raw.distance === 'number' && Number.isFinite(raw.distance) ? raw.distance : null;
	if (distance !== null && (distance < 0 || distance > FUZZYSEARCH_MAX_DISTANCE)) return null;

	const handles = Array.isArray(raw.artists)
		? raw.artists.filter((a): a is string => typeof a === 'string' && a.trim() !== '')
		: [];
	const rating = RATINGS.find((r) => r === raw.rating) ?? null;

	return {
		site,
		siteId,
		handles,
		distance,
		band: distanceBand(distance),
		postedAt: typeof raw.posted_at === 'string' ? raw.posted_at : null,
		rating,
		postUrl: postUrlFor(site, siteId, handles)
	};
}

/** Closest first; an unknown distance sorts last; ties break on site order. */
function compareMatches(a: LookupMatch, b: LookupMatch): number {
	const ad = a.distance ?? Number.POSITIVE_INFINITY;
	const bd = b.distance ?? Number.POSITIVE_INFINITY;
	if (ad !== bd) return ad - bd;
	return SITE_ORDER[a.site] - SITE_ORDER[b.site];
}

/** Normalize + filter + sort a raw v1/image payload. Exported for tests. */
export function normalizeMatches(payload: unknown): LookupMatch[] {
	if (!Array.isArray(payload)) return [];
	return payload
		.map((entry) => (entry && typeof entry === 'object' ? normalizeMatch(entry as RawMatch) : null))
		.filter((m): m is LookupMatch => m !== null)
		.sort(compareMatches);
}

/**
 * Drop the body of a response nobody is going to read. An unread stream holds
 * the subrequest open until the runtime reaps it, and on a failure path there
 * is nothing in the body worth keeping. Cancelling one that a `text()` already
 * drained throws, which is as harmless as the cancel itself.
 */
async function discardBody(res: Response): Promise<void> {
	try {
		await res.body?.cancel();
	} catch {
		// already read, already cancelled, or never had a body
	}
}

/**
 * Read at most `max` bytes of a response body as text. A body that runs past
 * the cap is cancelled and comes back null: a third party does not get to
 * decide how much of this isolate's memory its answer occupies, and neither the
 * 400 token nor the match list is anywhere near the caps above. An unreadable
 * body reads as null the same way. `res.body` is null on some responses (and
 * some test doubles), where `text()` is the only way in.
 */
async function readBounded(res: Response, max: number): Promise<string | null> {
	if (!res.body) return await res.text().catch(() => null);
	try {
		return new TextDecoder().decode(await bufferStream(res.body, max));
	} catch {
		// Over the cap (bufferStream cancelled the rest), or the stream errored.
		return null;
	}
}

/**
 * POST the bytes to FuzzySearch and return normalized matches.
 *
 * `fetchFn` is injected so tests drive this without globals. Failures are
 * returned as typed reasons rather than thrown: the caller maps each to a
 * status and a localized line, and the remote body never travels with them.
 */
export async function searchImage(
	bytes: Blob,
	key: string,
	fetchFn: typeof fetch = fetch
): Promise<LookupResult> {
	const form = new FormData();
	form.append('image', bytes, 'image');

	let res: Response;
	try {
		res = await fetchFn(FUZZYSEARCH_ENDPOINT, {
			method: 'POST',
			headers: { 'x-api-key': key },
			body: form,
			// Never follow a redirect: fetch would replay the key header at
			// whatever host the Location points to. A 3xx falls through to
			// `!res.ok` and reads as unavailable.
			redirect: 'manual',
			signal: AbortSignal.timeout(FUZZYSEARCH_TIMEOUT_MS)
		});
	} catch {
		// Network error or the timeout firing. Deliberately no logging: the error
		// can carry the request, and the request carries the key header.
		return { ok: false, reason: 'unavailable' };
	}

	// 403 alongside 401, the pair the registry client already treats as an auth
	// failure: a revoked or suspended key answers 403, and without it the
	// operator would never see the refused state for the one case they can fix.
	if (res.status === 401 || res.status === 403) {
		await discardBody(res);
		return { ok: false, reason: 'key_refused' };
	}
	if (res.status === 429) {
		await discardBody(res);
		return { ok: false, reason: 'rate_limited' };
	}
	if (res.status === 413) {
		await discardBody(res);
		return { ok: false, reason: 'too_large' };
	}
	if (res.status === 400) {
		// The one 400 worth distinguishing: FuzzySearch says the image is over its
		// own limit. Only the first FUZZYSEARCH_ERROR_BODY_BYTES are inspected for
		// that single token, and the body is discarded; one that runs past the cap
		// is not evidence of anything, so it falls through to invalid_image.
		const body = await readBounded(res, FUZZYSEARCH_ERROR_BODY_BYTES);
		await discardBody(res);
		return { ok: false, reason: body?.includes('too_large') ? 'too_large' : 'invalid_image' };
	}
	if (!res.ok) {
		await discardBody(res);
		return { ok: false, reason: 'unavailable' };
	}

	// Bounded like the error body above: `res.json()` would buffer whatever the
	// remote sends. Over the cap, unreadable, or unparsable all land on the
	// non-array path below.
	const text = await readBounded(res, FUZZYSEARCH_RESPONSE_BYTES);
	let payload: unknown = null;
	try {
		if (text !== null) payload = JSON.parse(text);
	} catch {
		payload = null;
	}
	// A 200 that isn't the documented array is a broken upstream, not a search
	// with no hits — reporting it as "no matches" would tell the operator their
	// art is unindexed when nobody actually looked.
	if (!Array.isArray(payload)) return { ok: false, reason: 'unavailable' };
	return { ok: true, matches: normalizeMatches(payload) };
}

/**
 * The match worth prefilling the form from: the closest exact or strong one.
 * `normalizeMatches` already sorted by distance then site, so the first
 * qualifying entry is the best one.
 */
export function pickPrefillMatch(matches: LookupMatch[]): LookupMatch | null {
	return matches.find((m) => m.band === 'exact' || m.band === 'strong') ?? null;
}

/**
 * The strictest rating carried by the confident matches, with the sites that
 * carried it — so the UI can say where an NSFW suggestion came from. Possible
 * and unknown-distance matches are excluded: a loose match must not flip the
 * operator's NSFW flag.
 */
export function strictestRating(
	matches: LookupMatch[]
): { rating: LookupRating; sites: LookupSite[] } | null {
	const confident = matches.filter((m) => m.band === 'exact' || m.band === 'strong');
	let best: LookupRating | null = null;
	for (const m of confident) {
		if (!m.rating) continue;
		if (best === null || RATINGS.indexOf(m.rating) > RATINGS.indexOf(best)) best = m.rating;
	}
	if (!best) return null;
	const sites: LookupSite[] = [];
	for (const m of confident) {
		if (m.rating === best && !sites.includes(m.site)) sites.push(m.site);
	}
	return { rating: best, sites };
}

/** The platform a site's handles live on, for the sites we hold a column for. */
const SITE_PLATFORM: Partial<Record<LookupSite, Platform>> = {
	FurAffinity: 'furaffinity',
	Twitter: 'twitter'
};

/**
 * Local artists whose stored socials point at one of a match's handles.
 * Compares through `normalizeHandle` and `socialsToHandles`, the same pair
 * `handlesOverlap` is built on, so this agrees with the registry import and the
 * artists API on what a match is.
 * A full scan, like every other handle matcher here — there is no handle index.
 */
export function findLocalArtists<T extends Record<string, unknown>>(
	rows: T[],
	match: Pick<LookupMatch, 'site' | 'handles'>
): T[] {
	const platform = SITE_PLATFORM[match.site];
	if (!platform) return [];
	const wanted = new Set(
		match.handles.map((h) => normalizeHandle(platform, h)).filter((h) => h !== '')
	);
	if (wanted.size === 0) return [];
	return rows.filter((row) =>
		socialsToHandles(row).some((h) => h.platform === platform && wanted.has(h.handleNorm))
	);
}

/**
 * Local artists whose display name equals a handle, case-insensitively. Weaker
 * evidence than a handle match (names collide), so it feeds the dialog's
 * "you may already have this artist" guard rather than an automatic link.
 */
export function findArtistsByName<T extends { name: string }>(rows: T[], handle: string): T[] {
	const needle = cleanHandle(handle).toLowerCase();
	if (!needle) return [];
	return rows.filter((row) => row.name.trim().toLowerCase() === needle);
}
