// Server-only FurTrack client. Runs on the Cloudflare Worker (server-to-server),
// which is the ONLY place these calls are allowed: FurTrack's API restricts CORS
// to its own origin, and — more importantly — direct API use requires approval
// from FurTrack's owner. This client therefore stays dark until two things are
// true: FURTRACK_MODE === 'live' AND we've been granted access. Until then it
// returns mock data ('mock') or nothing ('off').
//
// API + image-URL shapes are documented in the project's furtrack-api notes.

import type { FursuitPhoto, FurtrackMode } from '$lib/furtrack/types';
import type { SiteSettings } from '$lib/server/settings';
import { resolveLicense } from '$lib/furtrack/license';
import { MOCK_PHOTOS } from '$lib/furtrack/mock';
import { USER_AGENT } from '$lib/config';

const SOLAR = 'https://solar.furtrack.com';
const ORCA = 'https://orca2.furtrack.com';

/**
 * FurTrack requires the www.furtrack.com Origin + a Mozilla-style UA, or it 403s.
 * The per-request User-Agent (see furtrackUserAgent) is layered on top so FurTrack
 * can attribute traffic to this fork. (Stay low-volume / on-demand.)
 */
const REQUEST_HEADERS = {
	Referer: 'https://www.furtrack.com/',
	Origin: 'https://www.furtrack.com',
	Accept: 'application/json, text/plain, */*'
};

/** Product token identifying the Sona fursuit-photos integration in the UA. */
const UA_PRODUCT = 'Sona-Fursuit/1.0';

/**
 * User-Agent for outbound FurTrack requests. FurTrack 403s a non-Mozilla UA, so we
 * keep the Mozilla-style shell and embed fork-identifying details from site
 * settings — the site name, the operator's FurTrack profile URL, and the owner
 * name — so FurTrack can attribute traffic (and any abuse) to THIS fork. Unset
 * fields are skipped; with no site name we fall back to the generic build-time UA.
 */
export function furtrackUserAgent(
	settings?: Pick<SiteSettings, 'siteName' | 'ownerName' | 'furtrackUrl'>
): string {
	const siteName = settings?.siteName?.trim();
	if (!siteName) return USER_AGENT;
	const parts = [UA_PRODUCT, siteName];
	const profile = settings?.furtrackUrl?.trim();
	if (profile) parts.push(`+${profile}`);
	const owner = settings?.ownerName?.trim();
	if (owner && owner !== siteName) parts.push(owner);
	return `Mozilla/5.0 (compatible; ${parts.join('; ')})`;
}

/**
 * Hard cap on photos per character. Each photo = one FurTrack detail subrequest,
 * plus one index request, so this bounds the per-page fan-out. Kept at 24 to stay
 * well under Cloudflare's 50-subrequest/request limit even on the free plan.
 */
const MAX_PHOTOS = 24;
/** Max simultaneous detail requests against FurTrack. */
const CONCURRENCY = 5;
/** Per-request timeout so a slow/hanging FurTrack can't tie up the worker. */
const FETCH_TIMEOUT_MS = 5000;

type Env = { FURTRACK_MODE?: string };

export function getMode(env: Env | undefined): FurtrackMode {
	const m = (env?.FURTRACK_MODE ?? 'off').toString().toLowerCase();
	return m === 'live' || m === 'mock' ? m : 'off';
}

export interface CharacterPhotos {
	photos: FursuitPhoto[];
	/** True when the character has more photos than MAX_PHOTOS (results truncated). */
	capped: boolean;
}

/**
 * Fetch displayable fursuit photos for a character tag.
 * Returns `null` when the feature is disabled (mode 'off'), otherwise the photos
 * plus a `capped` flag. Only photos whose license permits reposting are included.
 */
export async function fetchCharacterPhotos(
	env: Env | undefined,
	character: string,
	fetchFn: typeof fetch,
	opts: { includeAll?: boolean; userAgent?: string } = {}
): Promise<CharacterPhotos | null> {
	const mode = getMode(env);
	if (mode === 'off') return null;

	if (mode === 'mock') {
		// Dev/preview: serve the bundled sample regardless of character.
		const photos = opts.includeAll ? MOCK_PHOTOS : MOCK_PHOTOS.filter((p) => p.license.displayable);
		return { photos, capped: false };
	}

	// mode === 'live' — real API calls (only reachable after approval).
	const userAgent = opts.userAgent ?? furtrackUserAgent();
	// Degrade gracefully: a FurTrack outage/rate-limit/404 must NOT take down the
	// gallery, so a failed index fetch yields an empty list rather than throwing.
	const tag = `1:${normalizeTag(character)}`;
	const index = await getJson(fetchFn, `${SOLAR}/get/index/${encodeURIComponent(tag)}`, userAgent).catch(
		(err) => {
			console.error(`FurTrack index fetch failed for ${tag}:`, err instanceof Error ? err.message : err);
			return null;
		}
	);
	const allPostIds: number[] = Array.isArray(index?.posts)
		? index.posts.map((p: { postId: number }) => p.postId)
		: [];
	const capped = allPostIds.length > MAX_PHOTOS;
	const postIds = allPostIds.slice(0, MAX_PHOTOS);

	const posts = await mapWithConcurrency(postIds, CONCURRENCY, (id) => fetchPost(fetchFn, id, userAgent));

	const all = posts.filter((p): p is FursuitPhoto => p !== null);
	// Public callers get only displayable (CC/PD) photos; admin import passes
	// includeAll to also surface excluded ones (shown as "excluded" in review).
	const photos = opts.includeAll ? all : all.filter((p) => p.license.displayable);

	return { photos, capped };
}

/**
 * Fetch a single fursuit photo by FurTrack post id.
 * Returns `null` when disabled, not found, or — importantly — when the photo's
 * license does not permit public display (so a direct URL can't expose a
 * restricted photo).
 */
export async function fetchPhoto(
	env: Env | undefined,
	id: number,
	fetchFn: typeof fetch,
	opts: { userAgent?: string } = {}
): Promise<FursuitPhoto | null> {
	const mode = getMode(env);
	if (mode === 'off') return null;
	if (mode === 'mock') return MOCK_PHOTOS.find((p) => p.id === id) ?? null;

	const photo = await fetchPost(fetchFn, id, opts.userAgent ?? furtrackUserAgent()).catch(() => null);
	if (!photo || !photo.license.displayable) return null;
	return photo;
}

async function fetchPost(fetchFn: typeof fetch, postId: number, userAgent: string): Promise<FursuitPhoto | null> {
	const data = await getJson(fetchFn, `${SOLAR}/view/post/${postId}`, userAgent).catch(() => null);
	const post = data?.post;
	if (!post) return null;

	// Trust nothing from the response: the id must be a clean positive integer
	// before it goes into URLs / route params.
	const id = Number(post.postId);
	if (!Number.isInteger(id) || id <= 0) return null;

	const tagNames: string[] = Array.isArray(data.tags)
		? data.tags.map((t: { tagName?: string }) => t.tagName).filter(Boolean)
		: [];

	// Photographer comes from the `3:` tag, which always identifies the photographer
	// regardless of who submitted the post. We link to that tag's FurTrack page
	// (the front-end uses the named `photographer:` prefix for tag type 3) rather
	// than a user account — no extra lookup needed, and it works even when the
	// photographer has no FurTrack account / their account name differs from the tag.
	const photographerTag = stripPrefix(tagNames.find((t) => t.startsWith('3:')));
	const photographer = photographerTag ?? 'Unknown photographer';
	const event = formatTag(stripPrefix(tagNames.find((t) => t.startsWith('5:'))));
	const character = stripPrefix(tagNames.find((t) => t.startsWith('1:')));
	const general = tagNames.filter((t) => !/^\d+:/.test(t));
	const description = typeof post.postDescription === 'string' ? post.postDescription.trim() : '';

	return {
		id,
		furtrackUrl: `https://www.furtrack.com/p/${id}`,
		description: description || undefined,
		imageUrl: `${ORCA}/gallery/${post.submitUserId}/${id}-${post.metaFingerprint}.${post.metaFiletype}`,
		width: post.metaWidth,
		height: post.metaHeight,
		photographer,
		photographerUrl: photographerTag ? `https://www.furtrack.com/index/photographer:${encodeURIComponent(photographerTag)}` : undefined,
		event,
		character,
		tags: general,
		takenAt: post.taken,
		license: resolveLicense(post.postCopyright)
	};
}

async function getJson(fetchFn: typeof fetch, url: string, userAgent: string): Promise<any> {
	const res = await fetchFn(url, {
		headers: { ...REQUEST_HEADERS, 'User-Agent': userAgent },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`FurTrack ${res.status} for ${url}`);
	return res.json();
}

function normalizeTag(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, '_');
}

function stripPrefix(tag: string | undefined): string | undefined {
	return tag ? tag.replace(/^\d+:/, '') : undefined;
}

function formatTag(tag: string | undefined): string | undefined {
	if (!tag) return undefined;
	return tag
		.split('_')
		.map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
		.join(' ');
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return results;
}
