// Server-only client for Skyseek (https://skyseek.app), a reverse image search
// over images posted to Bluesky. It answers "which Bluesky posts carry this
// picture", which FuzzySearch's index (FurAffinity, Weasyl, e621, Twitter) does
// not cover.
//
// Server-only for the reason fuzzysearch.ts is: the operator's artwork leaves
// this app only from a place we control, and only when the operator asks.
//
// Skyseek takes no API key. Its owner allows the JSON form of the search
// endpoint the site's own page posts to, and asks callers to identify
// themselves, which is what `lookupUserAgent` is for. The endpoint publishes its
// rate limit in `ratelimit-policy` (10 searches per 50-second window when this
// was written; the owner states it as 12 a minute). This client makes one
// request per lookup, never retries, and reads nothing from those headers: a
// 429 is the whole of what it needs to know.
//
// A match names a POST, not an artist: the account that posted a picture may be
// the artist, the person who commissioned it, or someone reposting it. Nothing
// here ranks one of those above another beyond putting the closest match, and
// then the earliest post, first.
//
// The second half of this file turns those posts into rows for "Look up
// artist": the posting accounts' handles, from Bluesky's public AppView, and
// the match shape the lookup endpoint answers with.

import { APP_NAME } from '$lib/config';
import {
	FUZZYSEARCH_MAX_DISTANCE,
	blueskyPostUrl,
	discardBody,
	distanceBand,
	readBounded,
	splitBlueskySiteId,
	type LookupMatch
} from './fuzzysearch';
import { normalizeHandle } from './handle-normalize';
import type { SkyseekFailReason } from '$lib/artist-lookup';

export const SKYSEEK_ENDPOINT = 'https://skyseek.app/search';
/** A match list is a few short objects per hit; past this the response is a
 * broken or hostile upstream, not a search result. */
export const SKYSEEK_RESPONSE_BYTES = 1024 * 1024;
/** Longer than FuzzySearch's bound: searches have measured between 0.7 and 5.9
 * seconds, and a timeout that close to a slow answer would fail working
 * lookups. */
export const SKYSEEK_TIMEOUT_MS = 10_000;
/** How many posts a lookup shows. A picture that went round Bluesky can match
 * hundreds of reposts; the list is earliest first, so the ones kept are the
 * likeliest originals. Equal to the AppView's cap on one getProfiles call, so
 * every post shown can have its handle resolved in the one request. */
export const SKYSEEK_MAX_MATCHES = 25;

/** Bluesky's public AppView: unauthenticated, read-only profile lookups. */
export const BLUESKY_PROFILES_ENDPOINT =
	'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles';
/** The most actors one getProfiles call accepts. */
export const BLUESKY_PROFILES_MAX_ACTORS = 25;
/** 25 full profile views (descriptions, labels, avatars) run to tens of KB. */
export const BLUESKY_PROFILES_RESPONSE_BYTES = 512 * 1024;
/** Short next to the search above: the handles are a nicety on rows the
 * operator already has, and are not worth holding the answer for. */
export const BLUESKY_PROFILES_TIMEOUT_MS = 5000;

/** A hostname as it may appear in a User-Agent: letters, digits, dots and
 * hyphens, starting and ending on a letter or digit. Anything else is left out
 * of the header altogether, so a hostile Host cannot add a line break, a
 * comment close, or a second product to it. */
const UA_HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/**
 * The User-Agent for this file's two requests: the software, the project's
 * public page, and, for Skyseek only, the hostname of the site the lookup was
 * asked from. Skyseek's owner asked for it, so traffic (and any trouble) can be
 * traced to one site instead of to every site running this software. Bluesky
 * did not ask, so its request gets the header without one. It names no person:
 * a hostname is already public, an owner's name or address is not this header's
 * to publish.
 *
 * With no usable hostname the header still identifies the software.
 */
export function lookupUserAgent(hostname?: string | null): string {
	const host = (hostname ?? '').trim().toLowerCase();
	const about = ['+https://sona.fast'];
	if (UA_HOSTNAME_PATTERN.test(host)) about.push(host);
	return `${APP_NAME}/1.0 (${about.join('; ')})`;
}

export interface SkyseekMatch {
	/** The posting account's DID. Stable across handle changes. */
	did: string;
	/** The post's record key in that account's repo. */
	rkey: string;
	/** How far the post's image is from the one searched for, on the scale
	 * FuzzySearch uses (a Hamming distance; 0 is the same picture). Null when
	 * the answer carries none. */
	distance: number | null;
	/** When the post was made, as an ISO date-time, or null when unknown. */
	postedAt: string | null;
	postUrl: string;
}

/** The client's list of Skyseek failures, so the two cannot drift. */
export type SkyseekFailure = SkyseekFailReason;

export type SkyseekResult =
	| { ok: true; matches: SkyseekMatch[] }
	| { ok: false; reason: SkyseekFailure };

/** The two DID methods Bluesky accounts use. Anything else is dropped: the DID
 * goes into a URL the operator is shown, and a value that is not one cannot be
 * trusted to stay inside the path segment it is put in. */
const DID_PATTERN = /^did:(?:plc:[a-z2-7]{24}|web:[A-Za-z0-9.-]+(?::[A-Za-z0-9._%-]+)*)$/;
/** The record-key grammar from the AT Protocol spec, minus ':': the path
 * separator's neighbour, and never present in the timestamp keys posts use. */
const RKEY_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;

/** Seconds since the epoch for the first Bluesky post anyone could have made
 * (the network's 2022 start), used as a floor: a timestamp before it is not a
 * post date, and one in milliseconds would land thousands of years out. */
const EARLIEST_POST_SECONDS = Date.UTC(2022, 0, 1) / 1000;

function toPostedAt(raw: unknown, now: number): string | null {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
	// A day of slack for clock skew; past it the value is not a date we can show.
	if (raw < EARLIEST_POST_SECONDS || raw > now / 1000 + 86_400) return null;
	return new Date(raw * 1000).toISOString();
}

interface RawSkyseekMatch {
	repo?: unknown;
	rkey?: unknown;
	created_at?: unknown;
	distance?: unknown;
}

function normalizeMatch(raw: RawSkyseekMatch, now: number): SkyseekMatch | null {
	const did = typeof raw.repo === 'string' ? raw.repo : '';
	const rkey = typeof raw.rkey === 'string' ? raw.rkey : '';
	if (!DID_PATTERN.test(did) || !RKEY_PATTERN.test(rkey)) return null;
	// A distance that is not a count of differing bits claims nothing: the match
	// stays, unbanded. The cap is applied by the caller, which has to tell a row
	// it could not read from one it read and found too far.
	const distance =
		typeof raw.distance === 'number' && Number.isFinite(raw.distance) && raw.distance >= 0
			? raw.distance
			: null;
	return {
		did,
		rkey,
		distance,
		postedAt: toPostedAt(raw.created_at, now),
		// Built from the DID and record key rather than taken from the response,
		// so a hostile payload cannot hand the operator an arbitrary link.
		postUrl: blueskyPostUrl(did, rkey)
	};
}

/** Closest first, an unknown distance last, the order FuzzySearch rows take.
 * Then earliest first: among several accounts that posted the same picture, the
 * first to post it is the likeliest original. A post with no usable date sorts
 * last. */
function compareSkyseekPosts(a: SkyseekMatch, b: SkyseekMatch): number {
	const ad = a.distance ?? Number.POSITIVE_INFINITY;
	const bd = b.distance ?? Number.POSITIVE_INFINITY;
	if (ad !== bd) return ad - bd;
	if (a.postedAt === b.postedAt) return 0;
	if (a.postedAt === null) return 1;
	if (b.postedAt === null) return -1;
	return a.postedAt < b.postedAt ? -1 : 1;
}

/**
 * The matches for the one image this client sends. Skyseek answers with one
 * inner list per uploaded image, so the first list is the whole answer here.
 * Returns null when the payload is not that shape at all, or holds hits of
 * which none is readable, which the caller reports as a failed lookup instead
 * of an empty one. Hits that are all past the distance cap are an empty answer.
 * Exported for tests.
 *
 * One post can come back more than once (a post carrying two near-identical
 * images), so rows are folded on DID + record key. The closest one stays, and
 * takes the other's date when it has none of its own.
 */
export function normalizeSkyseekMatches(
	payload: unknown,
	now: number = Date.now()
): SkyseekMatch[] | null {
	if (!payload || typeof payload !== 'object') return null;
	const body = payload as { success?: unknown; results?: unknown };
	if (body.success !== true || !Array.isArray(body.results)) return null;
	// No inner list at all is an answer about zero images, not zero matches.
	const first = body.results[0];
	if (!Array.isArray(first)) return null;

	const kept = new Map<string, SkyseekMatch>();
	let readable = false;
	for (const entry of first) {
		const match =
			entry && typeof entry === 'object' ? normalizeMatch(entry as RawSkyseekMatch, now) : null;
		if (!match) continue;
		readable = true;
		// One past the cap FuzzySearch rows are held to is noise rather than a
		// lead, and is dropped the way those rows are.
		if (match.distance !== null && match.distance > FUZZYSEARCH_MAX_DISTANCE) continue;
		const key = `${match.did}\u0000${match.rkey}`;
		const already = kept.get(key);
		if (!already) {
			kept.set(key, match);
			continue;
		}
		const closer = compareSkyseekPosts(match, already) < 0 ? match : already;
		const other = closer === match ? already : match;
		kept.set(key, { ...closer, postedAt: closer.postedAt ?? other.postedAt });
	}
	// Hits came back and not one could be read: the fields changed or the answer
	// is broken, and "no Bluesky post" would be a claim nobody checked.
	if (first.length > 0 && !readable) return null;
	return [...kept.values()].sort(compareSkyseekPosts);
}

/** A bounded body parsed as JSON, or null when it is past the cap or is not
 * JSON. The callers read null as "no answer". */
async function readBoundedJson(res: Response, maxBytes: number): Promise<unknown> {
	const text = await readBounded(res, maxBytes);
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * POST the bytes to Skyseek and return normalized matches.
 *
 * Same contract as `searchImage` in fuzzysearch.ts: `fetchFn` is injected so
 * tests drive this without globals, failures come back as typed reasons, and
 * the remote body never travels with them. One request, no retry: a 429 is
 * answered as rate_limited and left alone. `userAgent` is `lookupUserAgent` for
 * the site asking; without one the request still names the software.
 */
export async function searchSkyseek(
	bytes: Blob,
	fetchFn: typeof fetch = fetch,
	userAgent: string = lookupUserAgent()
): Promise<SkyseekResult> {
	const form = new FormData();
	form.append('image', bytes, 'image');

	let res: Response;
	try {
		res = await fetchFn(SKYSEEK_ENDPOINT, {
			method: 'POST',
			// Without this the endpoint answers with the HTML fragment its own page
			// swaps in.
			headers: { accept: 'application/json', 'user-agent': userAgent },
			body: form,
			// Never follow a redirect: fetch would replay the operator's image at
			// whatever host the Location points to.
			redirect: 'manual',
			signal: AbortSignal.timeout(SKYSEEK_TIMEOUT_MS)
		});
	} catch {
		return { ok: false, reason: 'unavailable' };
	}

	if (res.status === 429) {
		await discardBody(res);
		return { ok: false, reason: 'rate_limited' };
	}
	if (res.status === 413) {
		await discardBody(res);
		return { ok: false, reason: 'too_large' };
	}
	if (res.status === 400 || res.status === 415 || res.status === 422) {
		await discardBody(res);
		return { ok: false, reason: 'invalid_image' };
	}
	if (!res.ok) {
		await discardBody(res);
		return { ok: false, reason: 'unavailable' };
	}

	const payload = await readBoundedJson(res, SKYSEEK_RESPONSE_BYTES);
	// A 200 that isn't the JSON shape (the HTML fragment, a `success: false`, a
	// body past the cap) is a lookup that didn't happen. Reporting it as "no
	// matches" would tell the operator the piece isn't on Bluesky when nobody
	// actually looked.
	const matches = normalizeSkyseekMatches(payload);
	if (matches === null) return { ok: false, reason: 'unavailable' };
	return { ok: true, matches };
}

/** The handle grammar from the AT Protocol spec: a hostname of two or more
 * labels whose last label does not start with a digit. The handle goes into a
 * line the operator reads and into the local-artist match, so a value that is
 * not one is dropped rather than shown. */
const HANDLE_PATTERN =
	/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const HANDLE_MAX_LENGTH = 253;
/** What the AppView puts in `handle` for an account whose handle no longer
 * resolves to its DID. It names nobody. */
const INVALID_HANDLE = 'handle.invalid';

/**
 * The current handle of each DID, from ONE getProfiles request. Only the DIDs
 * are sent: nothing about the image, the operator, or this site.
 *
 * Every failure is an empty or partial map and never a throw. A match with no
 * resolved handle still links to its post by DID, so a slow or broken AppView
 * costs the operator a name on the row and nothing else. DIDs past the
 * AppView's per-call cap are left unresolved for the same reason: a second
 * request would be a second wait for the same nicety.
 *
 * `fetchFn` is injected, as in `searchSkyseek`. The User-Agent names the
 * software and never the site: there is no parameter for a hostname to arrive by.
 */
export async function resolveBlueskyHandles(
	dids: string[],
	fetchFn: typeof fetch = fetch
): Promise<Map<string, string>> {
	const handles = new Map<string, string>();
	// Only values this file would link to: the DIDs come from Skyseek's answer.
	const wanted = [...new Set(dids.filter((did) => DID_PATTERN.test(did)))].slice(
		0,
		BLUESKY_PROFILES_MAX_ACTORS
	);
	if (wanted.length === 0) return handles;

	const query = wanted.map((did) => `actors=${encodeURIComponent(did)}`).join('&');
	let res: Response;
	try {
		res = await fetchFn(`${BLUESKY_PROFILES_ENDPOINT}?${query}`, {
			headers: { accept: 'application/json', 'user-agent': lookupUserAgent() },
			redirect: 'manual',
			signal: AbortSignal.timeout(BLUESKY_PROFILES_TIMEOUT_MS)
		});
	} catch {
		return handles;
	}
	if (!res.ok) {
		await discardBody(res);
		return handles;
	}

	const payload = await readBoundedJson(res, BLUESKY_PROFILES_RESPONSE_BYTES);
	const profiles = (payload as { profiles?: unknown } | null)?.profiles;
	if (!Array.isArray(profiles)) return handles;

	for (const profile of profiles) {
		if (!profile || typeof profile !== 'object') continue;
		const { did, handle } = profile as { did?: unknown; handle?: unknown };
		// A profile for an account nobody asked about is not an answer to this
		// question, and the first answer for a DID is the one that stays.
		if (typeof did !== 'string' || !wanted.includes(did) || handles.has(did)) continue;
		if (typeof handle !== 'string' || handle.length > HANDLE_MAX_LENGTH) continue;
		if (!HANDLE_PATTERN.test(handle) || handle.toLowerCase() === INVALID_HANDLE) continue;
		handles.set(did, handle);
	}
	return handles;
}

/**
 * A Skyseek match as a row in the lookup's match list.
 *
 * The distance is Skyseek's own, on FuzzySearch's scale, so it is banded the
 * same way: an exact or strong Bluesky match is a confident one like any other,
 * and can be the match the form is filled from. One with no distance carries no
 * band and stays a lead. Skyseek reports no rating, so a Bluesky row never
 * raises one.
 *
 * The id is DID + record key, which is what makes a post unique; the DID is
 * also how `isOwnBlueskyPost` recognises the operator's account when no handle
 * resolved.
 */
export function skyseekLookupMatch(match: SkyseekMatch, handle: string | null): LookupMatch {
	return {
		site: 'Bluesky',
		siteId: `${match.did}/${match.rkey}`,
		handles: handle ? [handle] : [],
		distance: match.distance,
		band: distanceBand(match.distance),
		postedAt: match.postedAt,
		rating: null,
		postUrl: match.postUrl
	};
}

/** `value` with its percent escapes decoded, or as it stands when one is
 * malformed. */
function decodeEscapes(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Whether a Bluesky match was posted by the site operator's own account, given
 * the Bluesky link saved in the site's settings. The operator posting their own
 * commission is the commonest Bluesky match there is, and it says nothing about
 * who drew the piece.
 *
 * Compared the way local artists are matched (`normalizeHandle`), against the
 * resolved handle and against the DID, so a link saved as
 * bsky.app/profile/did:plc:… is recognised too, and so is one copied with its
 * colons percent-encoded (did%3Aplc%3A…), which the local-artist match also
 * decodes. A malformed escape is compared as it stands. An empty setting
 * matches nothing, and so does any match that is not a Bluesky one.
 */
export function isOwnBlueskyPost(
	match: Pick<LookupMatch, 'site' | 'siteId' | 'handles'>,
	ownBlueskyUrl: string | null | undefined
): boolean {
	if (match.site !== 'Bluesky') return false;
	const own = decodeEscapes(normalizeHandle('bluesky', ownBlueskyUrl));
	if (!own) return false;
	const did = splitBlueskySiteId(match.siteId).did.toLowerCase();
	return did === own || match.handles.some((h) => normalizeHandle('bluesky', h) === own);
}

/**
 * Whether a Bluesky match could be the operator's own post with nothing here to
 * say it is not: the site's link names a handle rather than a DID, and no
 * handle resolved for the match's account, so `isOwnBlueskyPost` had nothing to
 * compare. A link saved by DID is compared by DID and never needs this.
 */
export function mayBeOwnBlueskyPost(
	match: Pick<LookupMatch, 'site' | 'handles'>,
	ownBlueskyUrl: string | null | undefined
): boolean {
	if (match.site !== 'Bluesky' || match.handles.length > 0) return false;
	const own = decodeEscapes(normalizeHandle('bluesky', ownBlueskyUrl));
	return own !== '' && !own.startsWith('did:');
}
