import { json, error } from '@sveltejs/kit';
import { count, eq, isNotNull } from 'drizzle-orm';
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
	parseFuzzysearchRefusedMarker,
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
	// Anything >= 500 is counted into the operator's error rollup
	// (src/hooks.server.ts), so only a genuine server fault belongs up there: a
	// key FuzzySearch refuses is configuration, and an operator who saved a bad
	// key would otherwise see server errors on the observability panel with
	// every click. 424 (Failed Dependency) says the request depended on
	// FuzzySearch accepting the key. Not 401: the admin gate answers an expired
	// session with its own 401 and a plain-text body, so a 401 here would read
	// as a refused key and the caller's res.json() would throw. The gate emits
	// only 401 and 400, never 424. The body's `error` field is what tells
	// key_refused apart from unavailable.
	key_refused: 424,
	rate_limited: 429,
	too_large: 413,
	invalid_image: 422,
	// 502 deliberately: an upstream that failed IS a server fault and belongs in
	// the error rollup.
	unavailable: 502
};

/** Multipart framing (boundary lines + part headers) on top of the file cap,
 * so a file exactly at the cap still passes the declared-length pre-check and
 * is judged precisely by the exact size check. Mirrors /api/upload. */
const MULTIPART_SLACK_BYTES = 64 * 1024;

/** How long the stored image's BODY has to arrive, once its headers have.
 * PROXY_HEADERS_TIMEOUT_MS bounds only the wait for headers, so a storage host
 * that answers and then trickles bytes would otherwise hold the lookup open
 * until the platform killed the request — with the panel spinning the whole
 * time. Generous next to a stored image on a working host, short next to the
 * operator's patience. */
const BODY_BUFFER_TIMEOUT_MS = 20_000;

/**
 * The body with a deadline on the whole read: on expiry the upstream is
 * cancelled and this stream errors, which the caller answers with unavailable.
 * One timer, armed once when the stream is built, so this is a total budget for
 * the body and not an idle timeout. Deliberately: a host that trickles a byte at
 * a time would keep an idle timer alive forever, and it is the whole transfer
 * the operator is waiting on.
 */
function bodyWithDeadline(
	body: ReadableStream<Uint8Array>,
	ms: number
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			// Rejected BEFORE the upstream is cancelled: cancelling settles the read
			// this race is waiting on with done, and a stream that closed on the
			// deadline would hand the caller a truncated image rather than a failure.
			timedOut = true;
			reject(new Error('stored image body timed out'));
			void reader.cancel().catch(() => {});
		}, ms);
	});
	// The race below is the only consumer, and it is not created until the first
	// read — a rejection with nobody waiting is an unhandled rejection.
	expired.catch(() => {});
	return new ReadableStream({
		async pull(controller) {
			let read: Awaited<ReturnType<typeof reader.read>>;
			try {
				read = await Promise.race([reader.read(), expired]);
			} catch (e) {
				// The deadline rejects here, and so does an upstream that resets
				// mid-body. Either way this stream errors, and an errored stream never
				// calls `cancel` — the other place the timer is cleared. Without this
				// the timer stays armed on a request that has already been answered,
				// and fires `reader.cancel()` into a closed request context.
				clearTimeout(timer);
				throw e;
			}
			const { done, value } = read;
			if (timedOut) throw new Error('stored image body timed out');
			if (done) {
				clearTimeout(timer);
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		cancel(reason) {
			clearTimeout(timer);
			return reader.cancel(reason);
		}
	});
}

/** `forwarded` says whether the bytes reached FuzzySearch before this failure.
 * The gates below answer too_large and invalid_image with the same reason
 * FuzzySearch's own 413/400 carry, so the reason alone cannot tell the client
 * which side refused — and the private-image disclosure is built on that
 * difference. Every exit above `searchImage` owes the field: the returns below
 * carry it here, and the `error()` throws carry it in their own body, because a
 * failure the client cannot date is read as having been sent. */
function failure(reason: LookupFailure, forwarded: boolean) {
	return json({ enabled: true, error: reason, forwarded }, { status: FAILURE_STATUS[reason] });
}

/** Whether the leading bytes ARE one of the raster types on the allowlist.
 * Both request shapes get their type from someone else's word for it — the
 * browser's file.type, the upstream's Content-Type — so both hold the bytes
 * themselves to the same gate before anything reaches FuzzySearch. */
function hasAllowedImageBytes(head: Uint8Array): boolean {
	return isAllowedImageType(sniffImageType(head));
}

/** Artists whose stored socials or display name point at a match, per match.
 * `pieces` is how many images the artist already has: two artists can carry the
 * same display name, and the count is what lets the operator tell them apart in
 * the picker. */
interface ArtistHit {
	matchIndex: number;
	artists: Array<{ id: number; name: string; pieces: number }>;
}

export const POST: RequestHandler = async ({ request, platform, fetch }) => {
	const db = getDb(platform!.env.DB);

	// No key configured: the integration is off, not broken. The UI hides the
	// button on this answer instead of showing an error (the registry shape).
	//
	// Guarded like the reads below, and it matters most here: this is the
	// handler's FIRST await, and on a fork whose key lives in site settings
	// rather than the deploy secret it reads D1, where getRawSetting lets an
	// error propagate. Unguarded, a transient D1 fault answers 500 with no
	// `forwarded`, which the client reads as "the bytes were sent".
	let resolved: Awaited<ReturnType<typeof resolveFuzzysearchKey>>;
	try {
		resolved = await resolveFuzzysearchKey(db, platform?.env);
	} catch {
		return failure('unavailable', false);
	}
	if (!resolved) return json({ enabled: false, forwarded: false });

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
			return failure('too_large', false);
		}
		// Nothing on the pre-search side may reach SvelteKit's 500 handler. That
		// body carries no `forwarded`, and a failure the client cannot date is read
		// as having been sent — so the panel would show the private-image
		// disclosure for bytes that never left this endpoint, and the 500 would
		// land in the operator's error rollup (src/hooks.server.ts) as well. A
		// connection that drops mid-POST makes formData() reject, so it is guarded
		// like the JSON branch's parse below.
		let form: FormData;
		try {
			form = await request.formData();
		} catch (e) {
			// One rejection here is not an outage: the adapter enforces its own body
			// size limit while parsing, and refuses a body that overruns it with a
			// 413. That is the same refusal the declared-length check above makes, so
			// it keeps the same answer — a chunked body carries no content-length and
			// reaches the cap here instead.
			if (e && typeof e === 'object' && (e as { status?: unknown }).status === 413) {
				return failure('too_large', false);
			}
			return failure('unavailable', false);
		}
		const file = form.get('file');
		if (!(file instanceof File)) error(400, { message: 'No file provided', forwarded: false });
		// Layer 2: the exact check, on the file's real size.
		if (file.size > FUZZYSEARCH_MAX_BYTES) return failure('too_large', false);
		// The same raster gate /api/upload applies, and for the same reason the
		// imageId branch names the allowlist: an SVG or a PDF is not the
		// operator's artwork, and it is not something to hand a third party. The
		// declared type is the browser's word, so the leading bytes are checked
		// against the allowlist too (SNIFF_BYTES window, as in /api/upload).
		if (!isAllowedImageType(file.type)) return failure('invalid_image', false);
		// Same reason as formData() above: reading the part's leading bytes can
		// reject on a body that stopped arriving.
		let head: Uint8Array;
		try {
			head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
		} catch {
			return failure('unavailable', false);
		}
		if (!hasAllowedImageBytes(head)) return failure('invalid_image', false);
		bytes = file;
	} else {
		const body = (await request.json().catch(() => null)) as { imageId?: unknown } | null;
		const imageId = Number(body?.imageId);
		if (!Number.isInteger(imageId) || imageId <= 0)
			error(400, { message: 'Invalid image id', forwarded: false });

		// And the same for D1: a busy or unreachable database throws, and a typed
		// answer the client can read beats a 500 it cannot.
		let row: { id: number; imageUrl: string; parentImageId: number | null } | undefined;
		try {
			row = await db
				.select({ id: images.id, imageUrl: images.imageUrl, parentImageId: images.parentImageId })
				.from(images)
				.where(eq(images.id, imageId))
				.get();
		} catch {
			return failure('unavailable', false);
		}
		if (!row) error(404, { message: 'Image not found', forwarded: false });
		selfImage = { id: row.id, parentImageId: row.parentImageId };

		// Server-side fetch of a URL the SERVER looked up, with the shared
		// hardening: private and link-local hosts refused, redirects not followed,
		// only the stored raster types echoed back inline. A refusal, an upstream
		// error and a rejected fetch all arrive here as null.
		let stored: Awaited<ReturnType<typeof proxyStoredImage>> = null;
		try {
			stored = await proxyStoredImage(row.imageUrl, fetch);
		} catch {
			// It swallows its own fetch, parse and cancel errors today, but every
			// other await before the search is guarded and this one answers for
			// bytes that never left the worker: a throw here would reach the 500
			// handler with no `forwarded` field, and the edit page would show the
			// private notice for a file FuzzySearch never saw.
			return failure('unavailable', false);
		}
		if (!stored?.body) return failure('unavailable', false);
		// Lowercased: media types are case-insensitive, so an `Image/PNG` header
		// must pass the same check as `image/png`.
		const storedType = (stored.headers.get('content-type') ?? '')
			.split(';')[0]
			.trim()
			.toLowerCase();
		try {
			const buffered = await bufferStream(
				bodyWithDeadline(stored.body, BODY_BUFFER_TIMEOUT_MS),
				FUZZYSEARCH_MAX_BYTES
			);
			// The bytes decide, not the header: it is the upstream's claim the same
			// way file.type is the browser's, and the proxy hands anything it does
			// not recognize back as application/octet-stream — which used to refuse
			// a stored PNG served without a usable type. A response labelled
			// image/png carrying a PDF still goes nowhere. invalid_image, not
			// unavailable — the fetch worked, the content is what's wrong.
			const sniffed = sniffImageType(buffered.subarray(0, SNIFF_BYTES));
			if (!isAllowedImageType(sniffed)) return failure('invalid_image', false);
			// bufferStream allocates an exact-size array, so its backing buffer is
			// the payload with nothing else in it. A type rides along so the
			// multipart part FuzzySearch receives from the edit page looks like the
			// one the upload page sends (a File carries its own type) — the
			// upstream's where the allowlist accepts it, the sniffed one otherwise.
			bytes = new Blob([buffered.buffer as ArrayBuffer], {
				type: isAllowedImageType(storedType) ? storedType : (sniffed as string)
			});
		} catch (e) {
			if (e instanceof MaxBytesExceededError) return failure('too_large', false);
			return failure('unavailable', false);
		}
	}

	// searchImage catches its own failures, so this guard is a second, redundant
	// one. It is here because this is the handler's only unguarded await, and a
	// throw would answer 500 with no `forwarded` field for bytes that already
	// left the worker. forwarded is true for that reason: the file went out
	// whether or not the call came back.
	let result: Awaited<ReturnType<typeof searchImage>>;
	try {
		result = await searchImage(bytes, resolved.key, fetch);
	} catch (e) {
		console.warn(
			'artist-lookup: lookup threw after the file was sent',
			e instanceof Error ? e.message : e
		);
		return failure('unavailable', true);
	}

	if (!result.ok) {
		// A refused key is the one failure worth remembering: the settings page
		// tells the operator their key stopped working instead of leaving the
		// button failing silently. The marker records WHICH key was refused, so a
		// refusal against the deploy secret is never shown against a stored one.
		// The marker is a convenience for the settings page, not part of the
		// answer: a failed write must not turn a typed 424 into a 500 the caller
		// can't read. Nothing about the write's error names the body or the key.
		if (result.reason === 'key_refused') {
			try {
				await setRawSetting(
					db,
					FUZZYSEARCH_KEY_REFUSED_SETTING,
					fuzzysearchRefusedMarker(resolved.source)
				);
			} catch (e) {
				console.warn(
					'artist-lookup: refused-key marker not written',
					e instanceof Error ? e.message : e
				);
			}
		}
		return failure(result.reason, true);
	}

	// The key works — clear a stale refusal marker, but only the marker for the
	// key that just succeeded (a marker against the other source stays: a deploy
	// secret succeeding says nothing about the stored key FuzzySearch refused).
	// Read first, so the happy path costs one read rather than a write. Best
	// effort for the same reason as the write above: a settings row that won't
	// clear must not cost the operator the matches they asked for.
	try {
		const refusedMarker = parseFuzzysearchRefusedMarker(
			await getRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING)
		);
		if (refusedMarker && refusedMarker.source === resolved.source) {
			await setRawSetting(db, FUZZYSEARCH_KEY_REFUSED_SETTING, '');
		}
	} catch (e) {
		console.warn(
			'artist-lookup: refused-key marker not cleared',
			e instanceof Error ? e.message : e
		);
	}

	const matches = result.matches;
	// Every read below runs AFTER the bytes reached FuzzySearch, so a D1 fault
	// here is answered `forwarded: true` — the private-image notice on the edit
	// page is honest about a lookup that did leave the app. Answered as a typed
	// failure rather than thrown because a typed body can carry `forwarded: true`
	// and a thrown 500 cannot; it is still a 502 and still counted in the error
	// rollup, once.
	//
	// The matches are NOT returned with an empty localArtists instead: the panel
	// reads that as "no local artist has this handle" and offers to add one that
	// already exists, which is a duplicate artist row the operator then has to
	// find and merge. No answer beats a wrong one here.
	//
	// Only the reads are inside the try. The mapping and the response are built
	// below it, so a TypeError in that code keeps its own stack instead of
	// reporting as an upstream outage, and an `error()` added there later still
	// answers with its own status.
	let artistRows: {
		id: number;
		name: string;
		twitterUrl: string | null;
		furAffinityUrl: string | null;
	}[];
	const pieceCounts = new Map<number, number>();
	let sourceClash: Awaited<ReturnType<typeof findSourceClash>>;
	try {
		// The whole artist table, and the piece counts below, are only ever read
		// against a match — so a no-match answer reads neither. Same guard on both,
		// or the cheaper query is the one that stays behind.
		artistRows =
			matches.length > 0
				? await db
						.select({
							id: artists.id,
							name: artists.name,
							twitterUrl: artists.twitterUrl,
							furAffinityUrl: artists.furAffinityUrl
						})
						.from(artists)
				: [];

		// One grouped count for the whole gallery rather than a query per hit — the
		// picker needs it for at most a handful of artists, and a per-artist query
		// would fan out with the match list. Skipped when nothing matched. Every
		// image with the artist_id, variants and unpublished rows included: that is
		// what /admin/artists shows in its Artworks column, and two numbers for the
		// same artist on two admin screens is the worse answer. The unattributed
		// group has no artist to key on, so it is left out of the query.
		if (matches.length > 0) {
			const counted = await db
				.select({ artistId: images.artistId, pieces: count() })
				.from(images)
				.where(isNotNull(images.artistId))
				.groupBy(images.artistId);
			for (const row of counted)
				if (row.artistId !== null) pieceCounts.set(row.artistId, row.pieces);
		}
		sourceClash = await findSourceClash(db, matches, selfImage);
	} catch {
		return failure('unavailable', true);
	}

	const withPieces = (a: { id: number; name: string }) => ({
		id: a.id,
		name: a.name,
		pieces: pieceCounts.get(a.id) ?? 0
	});

	const localArtists: ArtistHit[] = [];
	const nameMatches: ArtistHit[] = [];
	matches.forEach((match, matchIndex) => {
		const byHandle = findLocalArtists(artistRows, match);
		if (byHandle.length) {
			localArtists.push({ matchIndex, artists: byHandle.map(withPieces) });
		}
		// Weaker evidence, kept separate: a name collision is a "you may already
		// have this artist" prompt, never an automatic link.
		const byName = new Map<number, { id: number; name: string; pieces: number }>();
		for (const handle of match.handles) {
			for (const a of findArtistsByName(artistRows, handle)) byName.set(a.id, withPieces(a));
		}
		if (byName.size) nameMatches.push({ matchIndex, artists: [...byName.values()] });
	});

	return json({
		enabled: true,
		matches,
		localArtists,
		nameMatches,
		sourceClash
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
	// Always re-read the root row: the scan above only selected what the equality
	// check needed, and the warning shows the operator the piece itself — its
	// thumbnail, who drew it, and when it was uploaded.
	const root = await db
		.select({
			title: images.title,
			thumbnailUrl: images.thumbnailUrl,
			imageUrl: images.imageUrl,
			width: images.width,
			height: images.height,
			createdAt: images.createdAt,
			artistName: artists.name
		})
		.from(images)
		.leftJoin(artists, eq(images.artistId, artists.id))
		.where(eq(images.id, rootId))
		.get();

	return {
		imageId: rootId,
		title: root?.title ?? first.title,
		// The stored thumbnail where there is one, the full image otherwise — a
		// row saved before thumbnails existed still gets a picture.
		thumbnailUrl: root?.thumbnailUrl ?? root?.imageUrl ?? null,
		artistName: root?.artistName ?? null,
		uploadedAt: root?.createdAt ?? null,
		width: root?.width ?? null,
		height: root?.height ?? null,
		isVariant: first.parentImageId !== null,
		parentImageId: first.parentImageId,
		// Only the reported set's own rows, and only the variants among them. The
		// root row itself is not always in the set — when just the variants carry
		// the source URL, subtracting one for a root that never matched would
		// undercount them. Two unrelated images that happen to carry the same
		// source URL are separate clashes, and counting them here would tell the
		// operator this one image has variants it doesn't have.
		variantCount: clashing.filter((r) => (r.parentImageId ?? r.id) === rootId && r.id !== rootId)
			.length
	};
}
