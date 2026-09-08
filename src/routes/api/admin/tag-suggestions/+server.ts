import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { images } from '$lib/server/db/schema';
import {
	classifySourceUrl,
	classifyMediaUrl,
	lookupBlueskyPost,
	type LookupFailure,
	type LookupOutcome
} from '$lib/server/entail';
import { fetchTweetMediaUrl } from '$lib/server/twitter-media';
import type { RequestHandler } from './$types';

// POST /api/admin/tag-suggestions  (admin-only via hooks — everything under
// /api except /api/cron/ requires the admin session).
//
// Suggests tags for an image from its source post, by asking entail.dev's
// public classifier what is in the picture (SONA-220). Two request shapes:
//
//   { imageId }        — the edit page, where the source URL is already stored.
//   { sourcePostUrl }  — the upload page, where there is no image row yet and
//                        the URL is whatever the operator has typed so far.
//
// Either shape goes through classifySourceUrl first, so the only URLs that
// ever leave this app are ones we built: the canonical bsky.app post URL, or
// the pbs.twimg.com media URL that X's own API handed back. A caller-supplied
// host is never fetched, which is what keeps the sourcePostUrl shape from
// being an SSRF hole.
//
// Nothing here runs on its own — no cron, no render path. entail.dev's
// response body is never logged or stored; only the normalized fields below
// are returned, and the tags have been through the same sanitizer the tag
// inputs use.

/** What the UI gets back for a failed lookup, and the status carrying it. */
const FAILURE_STATUS: Record<LookupFailure, number> = {
	// 502, not 401 or 503: the admin gate answers an expired session with its
	// own 401 and a plain-text body, so a 401 here would read as a logged-out
	// operator. The body's `error` field is what tells the cases apart.
	not_ready: 502,
	rate_limited: 429,
	unavailable: 502
};

const MAX_URL_LENGTH = 2048;
/** Read before parsing: a valid body is a short object with one field, so
 * anything past this is refused without handing it to JSON.parse. */
const MAX_BODY_BYTES = 4096;

const failure = (reason: LookupFailure) =>
	json({ error: reason }, { status: FAILURE_STATUS[reason] });

const invalid = () => json({ error: 'invalid_request' }, { status: 400 });

type Body = { imageId?: unknown; sourcePostUrl?: unknown };

export const POST: RequestHandler = async ({ request, platform }) => {
	const text = await request.text().catch(() => null);
	if (text === null || new TextEncoder().encode(text).length > MAX_BODY_BYTES) return invalid();
	let body: Body | null;
	try {
		body = JSON.parse(text);
	} catch {
		body = null;
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();

	const hasImageId = body.imageId !== undefined && body.imageId !== null;
	const hasUrl = body.sourcePostUrl !== undefined && body.sourcePostUrl !== null;
	// Exactly one: two fields would leave it ambiguous which one the operator
	// meant, and the answers can differ (the form's unsaved value against the
	// stored one).
	if (hasImageId === hasUrl) return invalid();

	let sourcePostUrl: string;
	if (hasImageId) {
		const imageId = body.imageId;
		if (typeof imageId !== 'number' || !Number.isInteger(imageId) || imageId <= 0) return invalid();

		const row = await getDb(platform!.env.DB)
			.select({ sourcePostUrl: images.sourcePostUrl })
			.from(images)
			.where(eq(images.id, imageId))
			.get();
		if (!row) return json({ error: 'not_found' }, { status: 404 });
		sourcePostUrl = row.sourcePostUrl ?? '';
	} else {
		if (typeof body.sourcePostUrl !== 'string') return invalid();
		if (body.sourcePostUrl.length > MAX_URL_LENGTH) return invalid();
		sourcePostUrl = body.sourcePostUrl;
	}

	// An image with no source post, or one pointing somewhere we have no
	// classifier for, is not a broken request — there is just nothing to ask.
	const source = classifySourceUrl(sourcePostUrl);
	if (!source) return json({ error: 'unsupported_source' }, { status: 422 });

	let outcome: LookupOutcome;
	// How many images the post carried. Only the Bluesky lookup and the tweet
	// lookup see the post; classifyMediaUrl sees one image.
	let imageCount: number;
	if (source.kind === 'bluesky') {
		outcome = await lookupBlueskyPost(source.url);
		if (!outcome.ok) return failure(outcome.reason);
		imageCount = outcome.imageCount;
	} else {
		// entail.dev indexes Bluesky, not X, so an X post has to be classified
		// from its image. X's API is the only thing that knows which image that
		// is, and it hands back a pbs.twimg.com URL — one of the two hosts
		// classifyMediaUrl will send on. Only the validated status id goes out.
		const media = await fetchTweetMediaUrl(source.id);
		if (!media.ok) return failure(media.reason);
		outcome = await classifyMediaUrl(media.url);
		if (!outcome.ok) return failure(outcome.reason);
		imageCount = media.photoCount;
	}

	return json({
		source: source.kind,
		tags: outcome.suggestions.tags,
		rating: outcome.suggestions.rating,
		imageCount
	});
};
