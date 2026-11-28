import { json, error } from '@sveltejs/kit';
import { count, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { images, artists, commissions } from '$lib/server/db/schema';
import { entryLinksPiece } from '$lib/server/commissions';
import { proxyStoredImage } from '$lib/server/image-proxy';
import { isAllowedImageType } from '$lib/server/storage/allowlist';
import { bufferStream, MaxBytesExceededError } from '$lib/server/storage/buffer';
import { sniffImageType } from '$lib/server/storage/sniff';
import { SNIFF_BYTES } from '$lib/server/storage/scrub-metadata';
import { getRawSetting, getRawSettings, setRawSetting } from '$lib/server/settings';
import {
	FUZZYSEARCH_KEY_REFUSED_SETTING,
	FUZZYSEARCH_MAX_BYTES,
	blueskyPostUrl,
	compareMatches,
	findArtistsByName,
	findLocalArtists,
	fuzzysearchRefusedMarker,
	normalizeSourceUrl,
	parseFuzzysearchRefusedMarker,
	pickPrefillMatch,
	resolveFuzzysearchKey,
	searchImage,
	splitBlueskySiteId,
	type LookupFailure,
	type LookupMatch
} from '$lib/server/fuzzysearch';
import {
	SKYSEEK_MAX_MATCHES,
	BLUESKY_CREDIT_MAX_POSTS,
	BLUESKY_OTHER_ACCOUNTS_SETTING,
	isOwnBlueskyAccount,
	isOwnBlueskyPost,
	lookupUserAgent,
	mayBeOwnBlueskyPost,
	readBlueskyCredits,
	resolveBlueskyHandles,
	searchSkyseek,
	skyseekLookupMatch,
	type SkyseekFailure,
	type SkyseekMatch
} from '$lib/server/skyseek';
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
//
// The same click searches Skyseek for Bluesky posts of the picture (SONA-243),
// whenever the FuzzySearch lookup is on: there is no second setting. The two
// searches run side by side once every gate below has passed, and the answer
// holds the rows of whichever service answered. With Skyseek down it is
// FuzzySearch's rows, `blueskySearched: false`, and `skyseekFailure`, the
// reason. With FuzzySearch down it is
// the Bluesky rows and `fuzzysearchFailure`, the reason. FuzzySearch's failure
// is the whole answer, with its own status, only when there is no Bluesky row
// to show beside it.

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

/** Art that came from a commission entry is never looked up (SONA-236): the
 * entry already names the artist. Refused before the stored copy is read, so
 * nothing about the piece exists in this request to hand over. 409, under 500
 * so it stays out of the error rollup, and neither 401 nor 403, which the client
 * reads as a session that ended. */
function fromCommissionRefusal() {
	return json({ enabled: true, error: 'from_commission', forwarded: false }, { status: 409 });
}

/** Whether the leading bytes ARE one of the raster types on the allowlist.
 * Both request shapes get their type from someone else's word for it — the
 * browser's file.type, the upstream's Content-Type — so both hold the bytes
 * themselves to the same gate before anything reaches FuzzySearch. */
function hasAllowedImageBytes(head: Uint8Array): boolean {
	return isAllowedImageType(sniffImageType(head));
}

/**
 * The Bluesky half of the lookup: Skyseek's posts, capped, with each posting
 * account's handle where the AppView gave one. A failure reason when Bluesky
 * was not searched, which the caller reports as that and never as "no Bluesky
 * posts". Anything that throws, the handle lookup included, is `unavailable`.
 *
 * The operator's own posts of the piece are not leads on who drew it, and are
 * left out before the cap, so a piece they posted many times cannot push other
 * accounts' posts off the list. `readOwnAccounts` is the site's Bluesky link and
 * the operator's other accounts from the settings.
 * Best effort: with it unreadable their posts stay, which costs rows they
 * recognise, where failing the lookup would cost every match they asked for.
 * Every post then loses its band, because any of them may be the operator's
 * own, and a banded one could fill the form or be offered as the artist. A site
 * with no account saved keeps its bands: there is nobody to mistake a poster for.
 *
 * What the operator's own posts do carry is their credit. The closest few are
 * read for the accounts they mention (`readBlueskyCredits`), and a post that
 * credits somebody comes back as a row naming those accounts, ahead of the
 * other accounts' posts in the cap.
 *
 * Never rejects. The caller starts this beside the FuzzySearch call and awaits
 * it after, outside any guard of its own, so a rejection here would answer 500
 * for bytes that already left the worker. Only the failure reason is logged, a
 * word from a fixed list: the response body stays in skyseek.ts.
 */
async function searchBluesky(
	bytes: Blob,
	fetchFn: typeof fetch,
	userAgent: string,
	readOwnAccounts: () => Promise<Array<string | null>>
): Promise<
	| { ok: true; matches: LookupMatch[]; posterHandles: Map<string, string> }
	| { ok: false; reason: SkyseekFailure }
> {
	try {
		const result = await searchSkyseek(bytes, fetchFn, userAgent);
		if (!result.ok) {
			console.warn('artist-lookup: Skyseek search failed', result.reason);
			return result;
		}
		if (result.matches.length === 0) return { ok: true, matches: [], posterHandles: new Map() };
		let own: Array<string | null> = [];
		let ownUnread = false;
		try {
			own = await readOwnAccounts();
		} catch (e) {
			ownUnread = true;
			console.warn(
				"artist-lookup: the site's Bluesky accounts were not read",
				e instanceof Error ? e.message : 'non-Error value'
			);
		}
		// An account saved by DID names the operator's posts before any handle is
		// known, so they take none of the handle lookup's places.
		const ownByDid = (post: SkyseekMatch) => isOwnBlueskyPost(skyseekLookupMatch(post, null), own);
		const posts = result.matches.filter((post) => !ownByDid(post));
		// One request, for the first accounts up to the cap, each asked about once
		// however many posts it made. The posts the cap below keeps are all by
		// those accounts, except at most the last one when the operator's account,
		// known only by handle, took one of the places.
		// Without the site's hostname: Skyseek's owner asked for it, Bluesky did not.
		const dids = [...new Set(posts.map((post) => post.did))].slice(0, SKYSEEK_MAX_MATCHES);
		// The global fetch, not the request's: SvelteKit's adds this site's origin
		// to a cross-origin request, and the AppView is told only the DIDs.
		const handles = await resolveBlueskyHandles(dids);
		const isOwn = (post: SkyseekMatch) =>
			isOwnBlueskyPost(skyseekLookupMatch(post, handles.get(post.did) ?? null), own);
		const credited = await creditedMatches(result.matches, own, handles);
		// With whatever the credit read resolved as well: a second account of the
		// operator's that the first request left out can be named there, and its
		// post is then theirs too.
		const known = credited.handles;
		const matches = posts
			.map((post) => skyseekLookupMatch(post, known.get(post.did) ?? null))
			.filter((match) => !isOwnBlueskyPost(match, own))
			// Closest first already, then earliest, so the cap keeps the best leads.
			.slice(0, SKYSEEK_MAX_MATCHES - credited.rows.length)
			// With an account saved by handle and none resolved for this one, the
			// post may be the operator's own. Shown, and banded as no claim, the way
			// a post with no distance is: it fills nothing and offers nobody. With the
			// accounts unread, every post may be.
			.map((match) =>
				ownUnread || mayBeOwnBlueskyPost(match, own) ? { ...match, band: null } : match
			);
		return { ok: true, matches: [...credited.rows, ...matches], posterHandles: credited.posterHandles };
	} catch (e) {
		console.warn(
			'artist-lookup: Skyseek search threw',
			e instanceof Error ? e.message : 'non-Error value'
		);
		return { ok: false, reason: 'unavailable' };
	}
}

/**
 * The operator's own posts of the piece, as rows naming the accounts each one
 * credits. A post that credits nobody gives no row, as before.
 *
 * `posts` is every post Skyseek found. The closest few of the operator's are
 * read, side by side, and then ONE more getProfiles request resolves the
 * credited accounts' handles. Where that names another of the operator's
 * accounts, its posts are read too, out of the same budget of
 * `BLUESKY_CREDIT_MAX_POSTS`. The operator's own accounts
 * are not a credit, by DID or by the handle that request returns.
 *
 * `posterHandles` is the posting account's handle for each row, by the row's
 * `siteId`, where one is known: the row's own `handles` are the credited
 * accounts', and the source-clash check needs the post's handle spelling. An
 * account known only by DID is asked about in the same request. `resolved` is
 * the handles the lookup already has.
 *
 * A post that credits one account keeps its band, so it can fill the form like
 * any other confident match. One that credits several loses it: nothing says
 * which of them drew the piece, and a banded row would fill the form from the
 * first. So does one whose credited account resolved no handle while one of the
 * operator's accounts is saved by handle: the mention may be of the operator.
 */
async function creditedMatches(
	posts: SkyseekMatch[],
	own: Array<string | null>,
	resolved: Map<string, string>
): Promise<{
	rows: LookupMatch[];
	posterHandles: Map<string, string>;
	/** `resolved`, with the handles the credit read added. */
	handles: Map<string, string>;
}> {
	const posterHandles = new Map<string, string>();
	const isOwnAuthor = (did: string, handle: string | null) => isOwnBlueskyAccount(did, handle, own);
	let handles = resolved;
	const read: SkyseekMatch[] = [];
	const credits: string[][] = [];
	// Two passes over one budget. The second is for a post that only reads as
	// the operator's once the first pass has named one of their accounts.
	for (let pass = 0; pass < 2 && read.length < BLUESKY_CREDIT_MAX_POSTS; pass++) {
		const known = handles;
		const next = posts
			.filter((post) => !read.includes(post))
			.filter((post) =>
				isOwnBlueskyPost(skyseekLookupMatch(post, known.get(post.did) ?? null), own)
			)
			.slice(0, BLUESKY_CREDIT_MAX_POSTS - read.length);
		if (next.length === 0) break;
		// The global fetch, for the reason the handle lookup uses it.
		const found = await Promise.all(next.map((post) => readBlueskyCredits(post, isOwnAuthor)));
		read.push(...next);
		credits.push(...found);
		if (found.flat().length === 0) continue;
		// Only the accounts no earlier request answered for, and what those did
		// answer stays known if this one fails.
		const unresolved = [...found.flat(), ...next.map((post) => post.did)].filter(
			(did) => !known.has(did)
		);
		if (unresolved.length > 0) {
			handles = new Map([...known, ...(await resolveBlueskyHandles([...new Set(unresolved)]))]);
		}
	}
	if (credits.flat().length === 0) return { rows: [], posterHandles, handles };
	const rows = read.flatMap((post, index) => {
		const creditedDids = credits[index].filter(
			(did) => !isOwnBlueskyAccount(did, handles.get(did) ?? null, own)
		);
		if (creditedDids.length === 0) return [];
		const match = skyseekLookupMatch(post, null);
		const poster = handles.get(post.did);
		if (poster) posterHandles.set(match.siteId, poster);
		const mayBeOwn =
			creditedDids.some((did) => !handles.has(did)) &&
			mayBeOwnBlueskyPost({ site: 'Bluesky', handles: [] }, own);
		return [
			{
				...match,
				handles: creditedDids.flatMap((did) => handles.get(did) ?? []),
				band: creditedDids.length === 1 && !mayBeOwn ? match.band : null,
				creditedDids
			}
		];
	});
	return { rows, posterHandles, handles };
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
	const contentType = request.headers.get('content-type') ?? '';

	// The imageId shape reads its row before the key, so art from an entry is
	// refused as that even with no key saved: "add a key" would send the owner to
	// Settings for a lookup that wouldn't run with one either. Only that refusal
	// is answered here. An invalid id, a missing row, and a failed read keep
	// their answers below the key check, as before.
	const imageId = contentType.includes('multipart/form-data')
		? null
		: Number(((await request.json().catch(() => null)) as { imageId?: unknown } | null)?.imageId);
	let row:
		| { id: number; imageUrl: string; parentImageId: number | null; commissionId: number | null }
		| undefined;
	let rowFailed = false;
	if (imageId !== null && Number.isInteger(imageId) && imageId > 0) {
		// And the same for D1 as for the key read below: a busy or unreachable
		// database throws, and a typed answer the client can read beats a 500 it
		// cannot.
		try {
			row = await db
				.select({
					id: images.id,
					imageUrl: images.imageUrl,
					parentImageId: images.parentImageId,
					commissionId: commissions.id
				})
				.from(images)
				// The piece or its parent: a variant of entry art is entry art too.
				.leftJoin(commissions, entryLinksPiece(images.id, images.parentImageId))
				.where(eq(images.id, imageId))
				.get();
		} catch {
			rowFailed = true;
		}
		if (row && row.commissionId !== null) return fromCommissionRefusal();
	}

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
		if (imageId === null || !Number.isInteger(imageId) || imageId <= 0)
			error(400, { message: 'Invalid image id', forwarded: false });
		if (rowFailed) return failure('unavailable', false);
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
			// The view itself, not its backing buffer: a Blob part honours a typed
			// array's offset and length, so the payload is what goes up even if
			// bufferStream ever returns a view into a larger allocation. A type
			// rides along so the multipart part FuzzySearch receives from the edit
			// page looks like the one the upload page sends (a File carries its own
			// type) — the upstream's where the allowlist accepts it, the sniffed one
			// otherwise.
			bytes = new Blob([buffered], {
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
	//
	// Skyseek is started first and awaited last, so the two searches overlap. A
	// FuzzySearch failure waits for Skyseek too, because the Bluesky rows are
	// shown without it: the wait is bounded by Skyseek's own timeout
	// (SKYSEEK_TIMEOUT_MS) plus the handle lookup's.
	//
	// The User-Agent names this site by the hostname the request came in on, which
	// Skyseek's owner asked callers to send. An unparseable URL leaves it off.
	let hostname: string | null = null;
	try {
		hostname = new URL(request.url).hostname;
	} catch {
		hostname = null;
	}
	const blueskyPending = searchBluesky(bytes, fetch, lookupUserAgent(hostname), async () => {
		// Both rows in one query. The second holds one account per line.
		const saved = await getRawSettings(db, ['blueskyUrl', BLUESKY_OTHER_ACCOUNTS_SETTING]);
		return [saved.blueskyUrl ?? null, ...(saved[BLUESKY_OTHER_ACCOUNTS_SETTING] ?? '').split('\n')];
	});
	let result: Awaited<ReturnType<typeof searchImage>>;
	try {
		result = await searchImage(bytes, resolved.key, fetch);
	} catch (e) {
		// The message of an Error, and never the value itself: a fetch failure can
		// throw an object holding the request that carried the FuzzySearch key,
		// and logging it whole would write that key to the worker's log.
		console.warn(
			'artist-lookup: lookup threw after the file was sent',
			e instanceof Error ? e.message : 'non-Error value'
		);
		// A FuzzySearch failure like any other below: Skyseek may still have rows.
		result = { ok: false, reason: 'unavailable' };
	}

	/** Why FuzzySearch gave no rows, or null when it answered. */
	let fuzzysearchFailure: LookupFailure | null = null;
	if (!result.ok) {
		fuzzysearchFailure = result.reason;
		// A refused key is the one failure worth remembering: the settings page
		// tells the operator their key stopped working instead of leaving the
		// button failing silently. The marker records WHICH key was refused, so a
		// refusal against the deploy secret is never shown against a stored one.
		// The marker is a convenience for the settings page, not part of the
		// answer: a failed write must not turn a typed 424 into a 500 the caller
		// can't read. Nothing about the write's error names the body or the key.
		// Written whether or not Bluesky rows turn this into a partial answer: the
		// key was refused either way.
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
					e instanceof Error ? e.message : 'non-Error value'
				);
			}
		}
	} else {
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
				e instanceof Error ? e.message : 'non-Error value'
			);
		}
	}

	// One list, in the order FuzzySearch's rows already had: closest first, then
	// site order, where Bluesky is last so a FuzzySearch row wins a tie. The sort
	// is stable, so rows that compare equal keep the order their own search gave
	// them, which for Bluesky is earliest post first.
	const bluesky = await blueskyPending;
	// The operator's own posts are already out (searchBluesky).
	const blueskyMatches = bluesky.ok ? bluesky.matches : [];
	// FuzzySearch failed and there is no Bluesky row to show in its place (Skyseek
	// failed too, found nothing, or found only the operator's own post), so the
	// failure is the whole answer, with the status it always had. Decided after
	// the own-post filter: a partial answer made of a row the filter then removed
	// would be an empty result that reads as "nothing matched".
	if (fuzzysearchFailure && blueskyMatches.length === 0) return failure(fuzzysearchFailure, true);
	// Sorted BEFORE anything below reads it: localArtists and nameMatches address
	// a match by its index in this list, and the client reads the same indexes.
	const matches = [...(result.ok ? result.matches : []), ...blueskyMatches].sort(compareMatches);
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
		blueskyUrl: string | null;
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
							furAffinityUrl: artists.furAffinityUrl,
							blueskyUrl: artists.blueskyUrl
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
		sourceClash = await findSourceClash(
			db,
			matches,
			selfImage,
			bluesky.ok ? bluesky.posterHandles : new Map()
		);
	} catch {
		// The fault is the database's, whatever FuzzySearch said: answering its
		// reason here would send the operator to fix a key or a file for a read
		// that a retry clears, and keep the local fault out of the 5xx rollup.
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
		sourceClash,
		// False is "Skyseek did not answer". An empty list is an answer.
		blueskySearched: bluesky.ok,
		// Why it did not, so the panel offers Try again only where a second send
		// can come back different. Null when Skyseek answered.
		skyseekFailure: bluesky.ok ? null : bluesky.reason,
		// Set only on a partial answer: the rows above are Bluesky posts alone,
		// and this is why. Null when FuzzySearch answered.
		fuzzysearchFailure
	});
};

/** The image (or variant set) already credited to the same source post, so the
 * UI can warn before the operator uploads a duplicate. */
async function findSourceClash(
	db: ReturnType<typeof getDb>,
	matches: LookupMatch[],
	selfImage: { id: number; parentImageId: number | null } | null,
	posterHandles: Map<string, string>
) {
	const prefill = pickPrefillMatch(matches);
	if (!prefill) return null;
	const target = normalizeSourceUrl(prefill.postUrl);
	if (!target) return null;
	// A Bluesky post has two spellings: by DID, which is what this endpoint
	// builds, and by handle, which is what bsky.app shows and an operator is
	// likeliest to have pasted. They are the same post, and only the handle
	// lookup can say so, so a match that resolved one is compared under both.
	// Without a resolved handle a piece saved under the handle spelling is
	// missed: nothing here can tell whose handle it is, and guessing would warn
	// about pieces that are not duplicates.
	const targets = new Set([target]);
	// A row that names credited accounts carries their handles, not the poster's,
	// so the operator's handle for it comes from `posterHandles`.
	if (prefill.site === 'Bluesky') {
		const { rkey } = splitBlueskySiteId(prefill.siteId);
		const poster = posterHandles.get(prefill.siteId);
		const handles = prefill.creditedDids ? (poster ? [poster] : []) : prefill.handles;
		for (const handle of handles) {
			const byHandle = normalizeSourceUrl(blueskyPostUrl(handle, rkey));
			if (byHandle) targets.add(byHandle);
		}
	}

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
		.filter((r) => targets.has(normalizeSourceUrl(r.sourcePostUrl)))
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
