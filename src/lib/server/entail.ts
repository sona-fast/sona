// entail.dev tag suggestions — a public, keyless classifier for furry artwork.
// Two entry points: a Bluesky post URL resolves through `/api/post` (the
// service has usually already classified it), and a raw media URL on an
// allowlisted CDN goes through the `/api/classify` enqueue-and-poll pair.
//
// Spec: https://entail.dev/api/openapi.json (docs at https://entail.dev/api/docs).
// Response shapes below were confirmed against the live API on 2026-09-08.
// Rate limiting is per client IP and there are no API keys, so a 429 is a
// normal outcome, not an error to surface.
//
// Everything here is fail-soft: any non-2xx, timeout, or unexpected shape
// resolves to null and the caller carries on without suggestions. Third-party
// response bodies are never logged and never stored.

import { sanitizeTag } from './validate';

const ENTAIL_POST = 'https://entail.dev/api/post';
const ENTAIL_CLASSIFY = 'https://entail.dev/api/classify';

/** The floor entail.dev's own docs recommend for Sona. */
export const DEFAULT_CONFIDENCE_FLOOR = 0.8;

// Budget: a /post lookup is one call. A classify is one POST plus at most
// three polls with a short pause between them, which keeps the worst case
// (3000 + 3 * 2000 + 2 * 250) just under ten seconds.
const POST_TIMEOUT_MS = 8000;
const CLASSIFY_TIMEOUT_MS = 3000;
const POLL_TIMEOUT_MS = 2000;
const POLL_PAUSE_MS = 250;
const POLL_ATTEMPTS = 3;

export type EntailRating = 'safe' | 'questionable' | 'explicit';

export type Suggestions = {
	tags: string[];
	rating: EntailRating | null;
};

/** One classification entry: an image inside a `/post` response, or the body
 * of a finished `/classify/<job_id>` poll. */
export type ClassificationEntry = {
	rating?: unknown;
	tags?: unknown;
};

export type SourceKind = { kind: 'bluesky'; url: string } | { kind: 'x'; url: string };

const BLUESKY_ACTOR = /^[A-Za-z0-9._:%-]{1,256}$/;
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
		const actor = decodeURIComponent(parts[1]);
		const rkey = parts[3];
		if (!BLUESKY_ACTOR.test(parts[1]) || !BLUESKY_RKEY.test(rkey)) return null;
		return { kind: 'bluesky', url: `https://bsky.app/profile/${actor}/post/${rkey}` };
	}

	if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.x.com' || host === 'mobile.twitter.com') {
		// /<user>/status/<id>, /i/status/<id>, either with a trailing /photo/N.
		if (parts.length < 3) return null;
		const [user, keyword, id] = parts;
		if (keyword !== 'status' && keyword !== 'statuses') return null;
		if (!STATUS_ID.test(id)) return null;
		if (user !== 'i' && !X_USER.test(user)) return null;
		return { kind: 'x', url: `https://x.com/${user}/status/${id}` };
	}

	return null;
}

/**
 * Translate one e621-vocabulary tag into a Sona tag. Drops the trailing
 * qualifier e621 appends to disambiguate (`digital_media_(artwork)`), swaps
 * underscores for hyphens, then runs the same sanitizer the tag inputs use.
 * Returns null when nothing usable is left. Pure.
 */
export function translateTag(tag: string): string | null {
	const translated = tag
		.trim()
		.toLowerCase()
		.replace(/[\s_]*\([^()]*\)\s*$/, '')
		.replace(/_/g, '-');
	const sanitized = sanitizeTag(translated);
	return sanitized || null;
}

function normalizeRating(rating: unknown): EntailRating | null {
	return rating === 'safe' || rating === 'questionable' || rating === 'explicit' ? rating : null;
}

/**
 * Turn one classification entry into Sona tag suggestions: keep the tags at or
 * above the confidence floor, translate them, and drop duplicates while
 * preserving the confidence order the API returns. Pure.
 */
export function suggestionsFromResult(
	result: ClassificationEntry | null | undefined,
	floor = DEFAULT_CONFIDENCE_FLOOR
): Suggestions {
	const rating = normalizeRating(result?.rating);
	const raw = Array.isArray(result?.tags) ? result.tags : [];
	const seen = new Set<string>();
	const tags: string[] = [];
	for (const entry of raw) {
		const { name, confidence } = (entry ?? {}) as { name?: unknown; confidence?: unknown };
		if (typeof name !== 'string') continue;
		if (typeof confidence !== 'number' || !(confidence >= floor)) continue;
		const tag = translateTag(name);
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		tags.push(tag);
	}
	return { tags, rating };
}

/** `/post` answers with `{ uri, images: [...] }`; tolerate a bare array too. */
function firstImage(body: unknown): ClassificationEntry | null {
	const images = Array.isArray(body)
		? body
		: Array.isArray((body as { images?: unknown })?.images)
			? ((body as { images: unknown[] }).images)
			: null;
	if (!images || images.length === 0) return null;
	const first = images[0];
	return first && typeof first === 'object' ? (first as ClassificationEntry) : null;
}

/**
 * Suggestions for a Bluesky post. Uses the post's first classified image; a
 * post whose images entail.dev hasn't classified yet answers 202, which we
 * treat as "nothing to suggest" rather than waiting around. Never throws.
 */
export async function lookupBlueskyPost(
	url: string,
	fetchImpl: typeof fetch = fetch
): Promise<Suggestions | null> {
	const source = classifySourceUrl(url);
	if (!source || source.kind !== 'bluesky') return null;

	const endpoint = `${ENTAIL_POST}?url=${encodeURIComponent(source.url)}&min_confidence=${DEFAULT_CONFIDENCE_FLOOR}&wait=true`;
	try {
		const res = await fetchImpl(endpoint, { signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
		if (res.status === 202) {
			// Queued for classification. Best effort: no retry loop.
			console.warn('[entail] post not classified yet: status=202');
			return null;
		}
		if (!res.ok) {
			console.warn(`[entail] post lookup failed: status=${res.status}`);
			return null;
		}
		const image = firstImage(await res.json());
		if (!image) return null;
		return suggestionsFromResult(image);
	} catch (e) {
		console.warn(`[entail] post lookup error: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

function jobIdFrom(body: unknown): string | null {
	const { job_id: jobId, id } = (body ?? {}) as { job_id?: unknown; id?: unknown };
	if (typeof jobId === 'string' && jobId) return jobId;
	if (typeof id === 'string' && id) return id;
	return null;
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
 * classification job, then poll it a few times. Gives up (null) if the job
 * isn't done by the attempt cap. Never throws.
 */
export async function classifyMediaUrl(
	url: string,
	fetchImpl: typeof fetch = fetch
): Promise<Suggestions | null> {
	if (!isAllowedMediaHost(url)) return null;

	try {
		const enqueued = await fetchImpl(ENTAIL_CLASSIFY, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url }),
			signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)
		});
		if (!enqueued.ok && enqueued.status !== 202) {
			console.warn(`[entail] classify enqueue failed: status=${enqueued.status}`);
			return null;
		}
		const jobId = jobIdFrom(await enqueued.json());
		if (!jobId) {
			console.warn('[entail] classify enqueue returned no job id');
			return null;
		}

		const poll = `${ENTAIL_CLASSIFY}/${encodeURIComponent(jobId)}?wait=true`;
		for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
			if (attempt > 0) await pause(POLL_PAUSE_MS);
			const res = await fetchImpl(poll, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
			if (res.status === 202) continue;
			if (!res.ok) {
				console.warn(`[entail] classify poll failed: status=${res.status}`);
				return null;
			}
			const body = (await res.json()) as (ClassificationEntry & { status?: unknown }) | null;
			if (body?.status !== 'done') continue;
			return suggestionsFromResult(body);
		}
		console.warn(`[entail] classify job unfinished after ${POLL_ATTEMPTS} polls`);
		return null;
	} catch (e) {
		console.warn(`[entail] classify error: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}
