// entail.dev tag suggestions — a public, keyless classifier for furry artwork.
// Two entry points: a Bluesky post URL resolves through `/api/post` (the
// service has usually already classified it), and a raw media URL on an
// allowlisted CDN goes through the `/api/classify` enqueue-and-poll pair.
//
// Spec: https://entail.dev/api/openapi.json (docs at https://entail.dev/api/docs).
// Response shapes below were confirmed against the live API on 2026-09-07.
// Rate limiting is per client IP and there are no API keys, so a 429 is a
// normal outcome, not an error to surface.
//
// Everything here is fail-soft: any non-2xx, timeout, or unexpected shape
// resolves to a failed outcome and the caller carries on without suggestions.
// Third-party response bodies are never logged and never stored.

import { errorLabel, timeoutSignal } from './fetch-errors';
import { sanitizeTag } from './validate';

const ENTAIL_POST = 'https://entail.dev/api/post';
const ENTAIL_CLASSIFY = 'https://entail.dev/api/classify';

/** The floor entail.dev's own docs recommend for Sona. */
export const DEFAULT_CONFIDENCE_FLOOR = 0.8;

/** Most tags a single lookup will suggest, counted after dedupe. The
 * classifier can return hundreds; the UI shows a short list. */
export const MAX_SUGGESTED_TAGS = 40;

/** Most raw entries one classification is read for. A body is third-party
 * input, so the walk stops here rather than following an array of any size. */
export const MAX_RAW_ENTRIES = 200;

// Both `wait=true` endpoints hold the connection open until the classifier
// finishes rather than answering 202 straight away. That hold was measured at
// roughly five seconds for a fresh job on 2026-09-07, so every timeout here
// has to clear it comfortably or we abort the very response we asked to wait
// for. A classify is one enqueue plus at most two polls, worst case about
// 3 + 8 + 0.25 + 8 seconds; the caller shows a pending state while it waits.
export const POST_TIMEOUT_MS = 8000;
const CLASSIFY_TIMEOUT_MS = 3000;
export const POLL_TIMEOUT_MS = 8000;
const POLL_PAUSE_MS = 250;
const POLL_ATTEMPTS = 2;

export type EntailRating = 'safe' | 'questionable' | 'explicit';

export type Suggestions = {
	tags: string[];
	rating: EntailRating | null;
};

/** Why a lookup produced nothing. `not_ready` is the one worth retrying: the
 * post is queued but not classified yet. `rate_limited` is entail.dev's per-IP
 * limit, which has no key to raise. Everything else — a timeout, a non-2xx, a
 * job that never finished — is `unavailable`, because none of them tell the
 * operator anything different. A post the classifier read and found nothing in
 * is not a failure at all; it succeeds with an empty tag list. */
export type LookupFailure = 'not_ready' | 'rate_limited' | 'unavailable';

/** `imageCount` is how many images the source post carried. Suggestions come
 * from the first one only, so a count above 1 tells the UI the rest went
 * unread. classifyMediaUrl has no post to count, so it reports 1 and the
 * endpoint substitutes the tweet's photo count on the X path. */
export type LookupOutcome =
	| { ok: true; suggestions: Suggestions; imageCount: number }
	| { ok: false; reason: LookupFailure };

const fail = (reason: LookupFailure): LookupOutcome => ({ ok: false, reason });

/** One classification entry: an image inside a `/post` response, or the body
 * of a finished `/classify/<job_id>` poll. */
export type ClassificationEntry = {
	rating?: unknown;
	tags?: unknown;
};

/** The `x` kind carries the status id so the tweet lookup never re-parses
 * the URL. */
export type SourceKind = { kind: 'bluesky'; url: string } | { kind: 'x'; url: string; id: string };

// Checked after percent-decoding, so a `%` that survives (a double-encoded
// actor) is rejected rather than decoded again downstream.
const BLUESKY_ACTOR = /^[A-Za-z0-9._:-]{1,256}$/;
const BLUESKY_RKEY = /^[A-Za-z0-9._~-]{1,64}$/;
const X_USER = /^[A-Za-z0-9_]{1,15}$/;
const STATUS_ID = /^\d{1,20}$/;

/**
 * Recognise a post URL we know how to get suggestions for, and return it in
 * canonical form (no query string, no trailing slash, no `/photo/1` suffix).
 * Anything else — including a bare media URL — returns null. Pure.
 */
export function classifySourceUrl(url: string): SourceKind | null {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

	const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
	const parts = parsed.pathname.split('/').filter(Boolean);

	if (host === 'bsky.app') {
		// /profile/<handle-or-did>/post/<rkey>
		if (parts.length !== 4 || parts[0] !== 'profile' || parts[2] !== 'post') return null;
		// Decode first, then validate the decoded actor: a malformed percent
		// sequence throws, and an encoded slash would otherwise pass the regex
		// and decode into a path separator in the canonical URL.
		let actor: string;
		try {
			actor = decodeURIComponent(parts[1]);
		} catch {
			return null;
		}
		const rkey = parts[3];
		if (!BLUESKY_ACTOR.test(actor) || !BLUESKY_RKEY.test(rkey)) return null;
		return { kind: 'bluesky', url: `https://bsky.app/profile/${actor}/post/${rkey}` };
	}

	if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.x.com' || host === 'mobile.twitter.com') {
		// /<user>/status/<id>, /i/status/<id>, /i/web/status/<id>, any with a
		// trailing /photo/N. The `/i/web/` permalink is the form X's own share
		// sheet hands out, so it canonicalises to /i/status/<id> like the rest.
		if (parts[0] === 'i' && parts[1] === 'web') parts.splice(1, 1);
		if (parts.length < 3) return null;
		const [user, keyword, id] = parts;
		if (keyword !== 'status' && keyword !== 'statuses') return null;
		if (!STATUS_ID.test(id)) return null;
		// `i` (the /i/status form) is a valid user segment by this pattern too.
		if (!X_USER.test(user)) return null;
		return { kind: 'x', url: `https://x.com/${user}/status/${id}`, id };
	}

	return null;
}

/**
 * Translate one e621-vocabulary tag into a Sona tag. Drops the trailing
 * qualifier e621 appends to disambiguate (`digital_media_(artwork)`), swaps
 * underscores for hyphens, then runs the same sanitizer the tag inputs use.
 * Emoticon tags (`<3`, `^_^`, `-_-`, `:3`) sanitize down to bare digits or
 * hyphens, so the result also needs a letter to count. Returns null when
 * nothing usable is left. Pure.
 */
export function translateTag(tag: string): string | null {
	const translated = tag
		.trim()
		.toLowerCase()
		.replace(/[\s_]*\([^()]*\)\s*$/, '')
		.replace(/_/g, '-');
	const sanitized = sanitizeTag(translated)
		.replace(/-{2,}/g, '-')
		.replace(/^-|-$/g, '');
	return /[a-z]/.test(sanitized) ? sanitized : null;
}

function normalizeRating(rating: unknown): EntailRating | null {
	return rating === 'safe' || rating === 'questionable' || rating === 'explicit' ? rating : null;
}

/**
 * Turn one classification entry into Sona tag suggestions: keep the tags at or
 * above the confidence floor, translate them, and drop duplicates while
 * preserving the confidence order the API returns, capped at
 * {@link MAX_SUGGESTED_TAGS}. Reads at most {@link MAX_RAW_ENTRIES} entries. Pure.
 */
export function suggestionsFromResult(result: ClassificationEntry | null | undefined): Suggestions {
	const rating = normalizeRating(result?.rating);
	const raw = Array.isArray(result?.tags) ? result.tags : [];
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const entry of raw.slice(0, MAX_RAW_ENTRIES)) {
		const { name, confidence } = (entry ?? {}) as { name?: unknown; confidence?: unknown };
		if (typeof name !== 'string') continue;
		if (typeof confidence !== 'number' || !(confidence >= DEFAULT_CONFIDENCE_FLOOR)) continue;
		const tag = translateTag(name);
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		tags.push(tag);
		if (tags.length >= MAX_SUGGESTED_TAGS) break;
	}
	return { tags, rating };
}

/** `/post` answers with `{ uri, images: [...] }`. A body without an `images`
 * array is a shape we don't know, so it resolves to null rather than to an
 * empty list that would read as "nothing to suggest". */
function postImages(body: unknown): ClassificationEntry[] | null {
	const images = (body as { images?: unknown })?.images;
	return Array.isArray(images) ? (images as ClassificationEntry[]) : null;
}

/**
 * Suggestions for a Bluesky post. Uses the post's first classified image; a
 * post whose images entail.dev hasn't classified yet answers 202, which we
 * treat as "nothing to suggest" rather than waiting around. Never throws.
 */
export async function lookupBlueskyPost(
	url: string,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal
): Promise<LookupOutcome> {
	const source = classifySourceUrl(url);
	if (!source || source.kind !== 'bluesky') return fail('unavailable');
	return lookupBlueskySource(source, fetchImpl, signal);
}

/**
 * The same lookup for a source classifySourceUrl has already validated. The
 * endpoint calls this directly so the canonical URL is not run through the
 * classifier (and percent-decoded) a second time. Never throws.
 */
export async function lookupBlueskySource(
	source: Extract<SourceKind, { kind: 'bluesky' }>,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal
): Promise<LookupOutcome> {
	const endpoint = `${ENTAIL_POST}?url=${encodeURIComponent(source.url)}&min_confidence=${DEFAULT_CONFIDENCE_FLOOR}&wait=true`;
	try {
		signal?.throwIfAborted();
		const res = await fetchImpl(endpoint, { signal: timeoutSignal(POST_TIMEOUT_MS, signal) });
		if (res.status === 202) {
			// Queued for classification. Best effort: no retry loop here — the
			// caller decides whether to ask again.
			console.warn('[entail] post not classified yet: status=202');
			return fail('not_ready');
		}
		if (res.status === 429) {
			console.warn('[entail] post lookup rate limited: status=429');
			return fail('rate_limited');
		}
		if (!res.ok) {
			console.warn(`[entail] post lookup failed: status=${res.status}`);
			return fail('unavailable');
		}
		// An empty `images` array means entail.dev looked and found no furry
		// artwork in the post. That is an answer, not a failure: the caller gets
		// an empty tag list rather than an error it would have to explain. A body
		// with no `images` array at all is neither; it is unavailable.
		const images = postImages(await res.json());
		if (!images) {
			console.warn('[entail] post lookup returned an unexpected shape');
			return fail('unavailable');
		}
		return {
			ok: true,
			suggestions: suggestionsFromResult(images[0]),
			imageCount: images.length
		};
	} catch (e) {
		console.warn(`[entail] post lookup error: ${errorLabel(e)}`);
		return fail('unavailable');
	}
}

function jobIdFrom(body: unknown): string | null {
	const { job_id: jobId } = (body ?? {}) as { job_id?: unknown };
	return typeof jobId === 'string' && jobId ? jobId : null;
}

/** entail.dev fetches the URL itself, so only the two CDNs it allowlists are
 * worth sending — anything else is refused there and never leaves here. */
function isAllowedMediaHost(url: string): boolean {
	try {
		const { protocol, hostname } = new URL(url);
		if (protocol !== 'https:') return false;
		const host = hostname.toLowerCase();
		return host === 'pbs.twimg.com' || host === 'cdn.bsky.app';
	} catch {
		return false;
	}
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Suggestions for a single image URL on an allowlisted CDN: enqueue a
 * classification job, then poll it a few times. Gives up (`unavailable`) if
 * the job isn't done by the attempt cap. Never throws.
 */
export async function classifyMediaUrl(
	url: string,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal
): Promise<LookupOutcome> {
	if (!isAllowedMediaHost(url)) return fail('unavailable');

	try {
		signal?.throwIfAborted();
		const enqueued = await fetchImpl(ENTAIL_CLASSIFY, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url }),
			signal: timeoutSignal(CLASSIFY_TIMEOUT_MS, signal)
		});
		if (enqueued.status === 429) {
			console.warn('[entail] classify enqueue rate limited: status=429');
			return fail('rate_limited');
		}
		if (!enqueued.ok && enqueued.status !== 202) {
			console.warn(`[entail] classify enqueue failed: status=${enqueued.status}`);
			return fail('unavailable');
		}
		const jobId = jobIdFrom(await enqueued.json());
		if (!jobId) {
			console.warn('[entail] classify enqueue returned no job id');
			return fail('unavailable');
		}

		const poll = `${ENTAIL_CLASSIFY}/${encodeURIComponent(jobId)}?wait=true`;
		for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
			if (attempt > 0) await pause(POLL_PAUSE_MS);
			const res = await fetchImpl(poll, { signal: timeoutSignal(POLL_TIMEOUT_MS, signal) });
			if (res.status === 202) continue;
			if (res.status === 429) {
				console.warn('[entail] classify poll rate limited: status=429');
				return fail('rate_limited');
			}
			if (!res.ok) {
				console.warn(`[entail] classify poll failed: status=${res.status}`);
				return fail('unavailable');
			}
			// The spec documents a 200 as "job done" and does not type a status
			// field, so only an explicit contradiction sends us back to poll.
			const body = (await res.json()) as (ClassificationEntry & { status?: unknown }) | null;
			if (body?.status && body.status !== 'done') continue;
			return { ok: true, suggestions: suggestionsFromResult(body), imageCount: 1 };
		}
		console.warn(`[entail] classify job unfinished after ${POLL_ATTEMPTS} polls`);
		return fail('unavailable');
	} catch (e) {
		console.warn(`[entail] classify error: ${errorLabel(e)}`);
		return fail('unavailable');
	}
}
