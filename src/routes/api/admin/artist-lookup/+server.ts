import { json, error } from '@sveltejs/kit';
import { eq, isNotNull } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { images, artists } from '$lib/server/db/schema';
import { proxyStoredImage } from '$lib/server/image-proxy';
import { isAllowedImageType } from '$lib/server/storage/allowlist';
import { bufferStream, MaxBytesExceededError } from '$lib/server/storage/buffer';
import { sniffImageType } from '$lib/server/storage/sniff';
import { SNIFF_BYTES } from '$lib/server/storage/scrub-metadata';
import { getRawSetting, setRawSetting } from '$lib/server/settings';
import {
	FUZZYSEARCH_KEY_REFUSED_SETTING,
	FUZZYSEARCH_MAX_BYTES,
	findArtistsByName,
	findLocalArtists,
	fuzzysearchRefusedMarker,
	normalizeSourceUrl,
	pickPrefillMatch,
	resolveFuzzysearchKey,
	searchImage,
	type LookupFailure,
	type LookupMatch
} from '$lib/server/fuzzysearch';
import type { RequestHandler } from './$types';

// POST /api/admin/artist-lookup  (admin-only via hooks — everything under /api
// except /api/cron/ requires the admin session).
//
// Reverse image search for "who drew this" (SONA-156). Two request shapes:
//
//   multipart/form-data with `file`  — the upload page, where the bytes are
//                                      still in the browser.
//   application/json { imageId }     — the edit page, where they are not: the
//                                      CSP's connect-src blocks the browser
//                                      from reading a stored image's bytes at
//                                      all (docs/reading-image-bytes.md).
//
// The imageId shape looks the URL up in D1 and fetches it server-side through
// proxyStoredImage, which is what keeps this from being an SSRF hole. A URL
// from the caller is never accepted, in either shape.
//
// Nothing leaves this app until an operator clicks: there is no cron, no
// render path, and no background call into this endpoint. FuzzySearch's own
// response body is never logged, stored, or echoed — only the normalized
// match list below.

/** What the UI gets back for a failed lookup, and the status carrying it. */
const FAILURE_STATUS: Record<LookupFailure, number> = {
	key_refused: 401,
	rate_limited: 429,
	too_large: 413,
	invalid_image: 422,
	unavailable: 502
};

/** Multipart framing (boundary lines + part headers) on top of the file cap,
 * so a file exactly at the cap still passes the declared-length pre-check and
 * is judged precisely by the exact size check. Mirrors /api/upload. */
const MULTIPART_SLACK_BYTES = 64 * 1024;

function failure(reason: LookupFailure) {
	return json({ enabled: true, error: reason }, { status: FAILURE_STATUS[reason] });
}

/** Artists whose stored socials or display name point at a match, per match. */
interface ArtistHit {
	matchIndex: number;
	artists: Array<{ id: number; name: string }>;
}

export const POST: RequestHandler = async ({ request, platform, fetch }) => {
	const db = getDb(platform!.env.DB);

	// No key configured: the integration is off, not broken. The UI hides the
	// button on this answer instead of showing an error (the registry shape).
	const resolved = await resolveFuzzysearchKey(db, platform?.env);
	if (!resolved) return json({ enabled: false });

	const contentType = request.headers.get('content-type') ?? '';

	let bytes: Blob;
	/** Set on the imageId shape: the image being looked up, excluded from its
	 * own source-URL clash check. */
	let selfImage: { id: number; parentImageId: number | null } | null = null;

	if (contentType.includes('multipart/form-data')) {
		// Layer 1 of the size cap: reject a body the client DECLARES oversized
		// before formData() materializes it. Absent or unparseable header falls
		// through to the exact check below — a chunked body carries no
		// content-length, so for that shape the exact check on file.size is the
		// only cap, and formData() buffers the part first. Accepted: this is an
		// admin-only route behind the session, so a buffered oversized part costs
		// the operator's own memory, and pre-counting the stream would mean
		// re-implementing multipart parsing for a caller we already trust.
		const declaredLength = Number(request.headers.get('content-length') ?? NaN);
		if (Number.isFinite(declaredLength) && declaredLength > FUZZYSEARCH_MAX_BYTES + MULTIPART_SLACK_BYTES) {
			return failure('too_large');
		}
		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File)) error(400, 'No file provided');
		// Layer 2: the exact check, on the file's real size.
		if (file.size > FUZZYSEARCH_MAX_BYTES) return failure('too_large');
		// The same raster gate /api/upload applies, and for the same reason the
		// imageId branch names the allowlist: an SVG or a PDF is not the
		// operator's artwork, and it is not something to hand a third party. The
		// declared type is the browser's word, so the leading bytes are checked
		// against the allowlist too (SNIFF_BYTES window, as in /api/upload).
		if (!isAllowedImageType(file.type)) return failure('invalid_image');
		const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
		if (!isAllowedImageType(sniffImageType(head))) return failure('invalid_image');
		bytes = file;
	} else {
		const body = (await request.json().catch(() => null)) as { imageId?: unknown } | null;
		const imageId = Number(body?.imageId);
		if (!Number.isInteger(imageId) || imageId <= 0) error(400, 'Invalid image id');

		const row = await db
			.select({ id: images.id, imageUrl: images.imageUrl, parentImageId: images.parentImageId })
			.from(images)
			.where(eq(images.id, imageId))
			.get();
		if (!row) error(404, 'Image not found');
		selfImage = { id: row.id, parentImageId: row.parentImageId };

		// Server-side fetch of a URL the SERVER looked up, with the shared
		// hardening: private and link-local hosts refused, redirects not followed,
		// only the stored raster types echoed back inline. A refusal, an upstream
		// error and a rejected fetch all arrive here as null.
		const stored = await proxyStoredImage(row.imageUrl, fetch);
		if (!stored?.body) return failure('unavailable');
		// Lowercased: media types are case-insensitive, so an `Image/PNG` header
		// must pass the same check as `image/png`.
		const storedType = (stored.headers.get('content-type') ?? '')
			.split(';')[0]
			.trim()
			.toLowerCase();
		// The same allowlist the proxy applies, named rather than re-guessed: the
		// proxy hands anything outside it back as application/octet-stream, and
		// `image/*` would also let through the SVG it deliberately demoted.
		if (!isAllowedImageType(storedType)) {
			// Release the subrequest's stream: nothing reads this body, and an
			// unread one keeps the connection open for the rest of the invocation.
			await stored.body.cancel().catch(() => {});
			return failure('unavailable');
		}
		try {
			const buffered = await bufferStream(stored.body, FUZZYSEARCH_MAX_BYTES);
			// bufferStream allocates an exact-size array, so its backing buffer is
			// the payload with nothing else in it. The validated type rides along so
			// the multipart part FuzzySearch receives from the edit page looks like
			// the one the upload page sends (a File carries its own type).
			bytes = new Blob([buffered.buffer as ArrayBuffer], { type: storedType });
		} catch (e) {
			if (e instanceof MaxBytesExceededError) return failure('too_large');
			return failure('unavailable');
		}
	}

	const result = await searchImage(bytes, resolved.key, fetch);

	if (!result.ok) {
		// A refused key is the one failure worth remembering: the settings page
		// tells the operator their key stopped working instead of leaving the
		// button failing silently. The marker records WHICH key was refused, so a
		// refusal against the deploy secret is never shown against a stored one.
		if (result.reason === 'key_refused') {
			await setRawSetting(
				db,
				FUZZYSEARCH_KEY_REFUSED_SETTING,
				fuzzysearchRefusedMarker(resolved.source)
			);
		}
		return failure(result.reason);
	}

	// The key works — clear a stale refusal marker (only when one is set, so the
	// happy path costs one read rather than a write).
	if (await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)) {
		await setRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING, '');
	}

	const matches = result.matches;
	const artistRows = await db
		.select({
			id: artists.id,
			name: artists.name,
			twitterUrl: artists.twitterUrl,
			furAffinityUrl: artists.furAffinityUrl
		})
		.from(artists);

	const localArtists: ArtistHit[] = [];
	const nameMatches: ArtistHit[] = [];
	matches.forEach((match, matchIndex) => {
		const byHandle = findLocalArtists(artistRows, match);
		if (byHandle.length) {
			localArtists.push({ matchIndex, artists: byHandle.map((a) => ({ id: a.id, name: a.name })) });
		}
		// Weaker evidence, kept separate: a name collision is a "you may already
		// have this artist" prompt, never an automatic link.
		const byName = new Map<number, { id: number; name: string }>();
		for (const handle of match.handles) {
			for (const a of findArtistsByName(artistRows, handle)) byName.set(a.id, { id: a.id, name: a.name });
		}
		if (byName.size) nameMatches.push({ matchIndex, artists: [...byName.values()] });
	});

	return json({
		enabled: true,
		matches,
		localArtists,
		nameMatches,
		sourceClash: await findSourceClash(db, matches, selfImage)
	});
};

/** The image (or variant set) already credited to the same source post, so the
 * UI can warn before the operator uploads a duplicate. */
async function findSourceClash(
	db: ReturnType<typeof getDb>,
	matches: LookupMatch[],
	selfImage: { id: number; parentImageId: number | null } | null
) {
	const prefill = pickPrefillMatch(matches);
	if (!prefill) return null;
	const target = normalizeSourceUrl(prefill.postUrl);
	if (!target) return null;

	const rows = await db
		.select({
			id: images.id,
			title: images.title,
			parentImageId: images.parentImageId,
			sourcePostUrl: images.sourcePostUrl
		})
		.from(images)
		.where(isNotNull(images.sourcePostUrl));

	// The image being looked up is not a clash with itself, and neither are its
	// own variants — they legitimately share one source post.
	const selfRoot = selfImage ? (selfImage.parentImageId ?? selfImage.id) : null;
	const clashing = rows
		.filter((r) => normalizeSourceUrl(r.sourcePostUrl) === target)
		.filter((r) => selfRoot === null || (r.parentImageId ?? r.id) !== selfRoot)
		.sort((a, b) => a.id - b.id);
	if (clashing.length === 0) return null;

	const first = clashing[0];
	const rootId = first.parentImageId ?? first.id;
	const root =
		first.parentImageId === null
			? { title: first.title }
			: await db.select({ title: images.title }).from(images).where(eq(images.id, rootId)).get();

	return {
		imageId: rootId,
		title: root?.title ?? first.title,
		isVariant: first.parentImageId !== null,
		parentImageId: first.parentImageId,
		// Only the reported set's own rows. Two unrelated images that happen to
		// carry the same source URL are separate clashes, and counting them here
		// would tell the operator this one image has variants it doesn't have.
		variantCount: clashing.filter((r) => (r.parentImageId ?? r.id) === rootId).length - 1
	};
}
