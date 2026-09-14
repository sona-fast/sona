// The state machine behind the "Suggest tags" control (SONA-220), kept out of
// the component so every branch can be tested without a browser.
//
// The component owns one `SuggestionState` at a time. Everything here is pure:
// `fromResponse` turns one answer from POST /api/admin/tag-suggestions into a
// state, `toggleTag` flips a chip, and `applyTo` writes the accepted tags into
// the comma-separated Tags input. Nothing here fetches, and nothing here
// persists — the forms stage tags until their own Save.
//
// `requestSuggestions` is the one exception to "nothing here fetches": the two
// forms and the backfill page all make the same POST and read its answer the
// same way, so the call lives here once rather than three times.

import { sanitizeTag, TAG_MAX_LENGTH, type SourceKind } from '$lib/tags';
import * as m from '$lib/paraglide/messages';

export type EntailRating = 'safe' | 'questionable' | 'explicit';

/** Which post the lookup is reading, for the "Reading the Bluesky post" line. */
export type SuggestionSource = 'bluesky' | 'x';

export type SuggestionState =
	/** No lookup has run. The pill is enabled and the tray is absent. */
	| { kind: 'idle' }
	/** The source URL field holds nothing we can look up; the pill is disabled. */
	| { kind: 'noSource' }
	/** A lookup is in flight. */
	| { kind: 'searching'; source: SuggestionSource }
	/** Tags came back. `leftOut` holds the ones the operator clicked off, so the
	 *  chip order stays the classifier's confidence order either way. */
	| {
			kind: 'suggested';
			tags: string[];
			leftOut: Set<string>;
			rating: EntailRating | null;
			imageCount: number;
			/** True when at least one returned tag was dropped because the Tags
			 *  field already had it — the tray then says so. */
			skippedExisting: boolean;
	  }
	/** The operator accepted `count` tags; they are in the Tags field now. The
	 *  rating outlives this transition and is held by the caller, so it is not
	 *  repeated here. */
	| { kind: 'applied'; count: number }
	/** The post was read and there is nothing worth suggesting. `skippedExisting`
	 *  is true when there was something and the Tags field already held all of
	 *  it: the tray then says the tags were skipped rather than that entail.dev
	 *  found nothing, which would be false. `noImage` is true when the post
	 *  carried no picture at all — an X post that is text, video or a GIF —
	 *  where saying the classifier read the post and was unconvinced would be
	 *  false too. */
	| { kind: 'empty'; skippedExisting?: boolean; noImage?: boolean }
	/** 202: queued or still classifying. Retryable. */
	| { kind: 'notReady' }
	/** 502: an upstream failure. Retryable. */
	| { kind: 'unavailable' }
	/** 429: entail.dev's or X's per-IP limit. Retryable. */
	| { kind: 'rateLimited' }
	/** 404: the post could not be read, or the classifier declined it. */
	| { kind: 'notFound' }
	/** 401: the admin session expired or was revoked. Another click sends the same
	 *  dead cookie, so this one offers a way back to the login page instead of a
	 *  Try again that can only fail. */
	| { kind: 'signedOut' }
	/** 400: the endpoint refused the link itself — a URL past its length cap, say.
	 *  Another click sends the same link, so this one offers no Try again. */
	| { kind: 'badLink' };

/** The shape POST /api/admin/tag-suggestions answers a 200 with. Everything is
 * `unknown` on the way in: this is a response body, not a promise. */
type SuggestionBody = {
	tags?: unknown;
	rating?: unknown;
	imageCount?: unknown;
	/** 'bluesky' or 'x', echoed by the endpoint. Only the X path answers
	 *  imageCount 0 for a post that carried no picture. */
	source?: unknown;
};

/** Characters a chip label never legitimately holds: every control character
 * (\p{Cc}, which is C0, DEL and the C1 block — the next line U+0085 among them),
 * every format character (\p{Cf} covers the bidirectional overrides and isolates
 * that can reorder the text around them, and the zero-width joiners that make
 * two labels look alike), the line and paragraph separators, and the comma. A tag
 * name comes back from an endpoint that read somebody else's post, and the comma
 * is the Tags field's own separator — left in, one accepted tag would become two
 * the moment `applyTo` joined the field back up. */
const UNSAFE_LABEL_CHARS = /[\p{Cc},\p{Cf}\p{Zl}\p{Zp}]/gu;

// Capped where sanitizeTag caps what it stores, so a chip never shows more of a
// label than Save would keep. Sliced by code point, not by UTF-16 unit: a cut
// through the middle of an astral character leaves a lone surrogate on the chip.
function cleanLabel(value: string): string {
	return Array.from(value.replace(UNSAFE_LABEL_CHARS, ''))
		.slice(0, TAG_MAX_LENGTH)
		.join('');
}

const RATINGS: readonly string[] = ['safe', 'questionable', 'explicit'];

function readRating(value: unknown): EntailRating | null {
	return typeof value === 'string' && RATINGS.includes(value) ? (value as EntailRating) : null;
}

/** Split a comma-separated Tags input into the tag names it holds. */
export function parseTagInput(value: string): string[] {
	return value
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * Map one endpoint answer onto a state. `existingTags` is what the Tags input
 * holds right now; a suggestion the operator already typed is dropped, matched
 * through `sanitizeTag` so "Digital Media" and "digital-media" count as one.
 *
 * 202 is inside `res.ok`, so callers branch on the status, not on `ok`.
 */
export function fromResponse(
	status: number,
	body: unknown,
	existingTags: string[]
): SuggestionState {
	if (status === 202) return { kind: 'notReady' };
	if (status === 404) return { kind: 'notFound' };
	if (status === 429) return { kind: 'rateLimited' };
	// 401 is the admin session, not entail.dev: the hook answers it with a text
	// body, so blaming the classifier would send the operator round a Try again
	// that fails the same way forever.
	if (status === 401) return { kind: 'signedOut' };
	// 422 is "this URL is not a Bluesky or X post", refused by the endpoint's own
	// recogniser before anything is sent. The pill should not have been
	// clickable, so the sentence names the link the site cannot look up rather
	// than blaming entail.dev for an answer it was never asked for.
	if (status === 422) return { kind: 'noSource' };
	// 400 is the endpoint refusing the link, not entail.dev failing to answer —
	// an over-long URL, say. Saying "try again" would offer a click that sends
	// the same link and fails the same way.
	if (status === 400) return { kind: 'badLink' };
	if (status !== 200) return { kind: 'unavailable' };

	// A 200 that is not the shape this endpoint answers with is not an empty
	// answer: a re-gated fork puts an HTML login page behind the same URL, and
	// reading that as "found nothing" would drop the Try again the operator
	// needs once the gate lets them through.
	if (typeof body !== 'object' || body === null) return { kind: 'unavailable' };
	const payload = body as SuggestionBody;
	if (!Array.isArray(payload.tags)) return { kind: 'unavailable' };
	const raw = payload.tags;
	const already = new Set(existingTags.map(sanitizeTag).filter(Boolean));

	const tags: string[] = [];
	const seen = new Set<string>();
	let skippedExisting = false;
	for (const entry of raw) {
		if (typeof entry !== 'string') continue;
		// The key is taken from the LABEL, not from the raw entry: the two
		// disagree about the whitespace controls, which cleanLabel deletes and
		// sanitizeTag hyphenates. Keyed off the raw entry, 'fox\tkit' and 'foxkit'
		// get different keys and the same label, and the keyed {#each} over the
		// chips throws each_key_duplicate.
		const label = cleanLabel(entry);
		const key = sanitizeTag(label);
		if (!key) continue;
		if (already.has(key)) {
			skippedExisting = true;
			continue;
		}
		// The endpoint already dedupes, but the input is a response body.
		if (seen.has(key)) continue;
		seen.add(key);
		tags.push(label);
	}

	const count = Number(payload.imageCount);

	// Nothing came back and the post carried no picture: only the X path answers
	// that, and it answers it without asking entail.dev anything, so the tray can
	// say the post had nothing to look at rather than crediting the classifier
	// with a verdict. A Bluesky post reaches imageCount 0 the other way round —
	// entail.dev looked and classified nothing — so it keeps the general
	// sentence.
	if (tags.length === 0)
		return { kind: 'empty', skippedExisting, noImage: count === 0 && payload.source === 'x' };

	return {
		kind: 'suggested',
		tags,
		leftOut: new Set(),
		rating: readRating(payload.rating),
		imageCount: Number.isInteger(count) && count > 0 ? count : 1,
		skippedExisting
	};
}

/**
 * Which post a recognised source URL names, as one string, or null for no
 * post. The forms keep an answer only while the field still names the post it
 * answered, and compare through this rather than through the canonical URL: an
 * X status is one tweet under every handle (`/i/web/status/<id>` from the
 * share sheet, `/<handle>/status/<id>` from the address bar), and the canonical
 * URL keeps the handle. A Bluesky post is its canonical URL.
 */
export function sourceKey(source: SourceKind | null): string | null {
	if (source === null) return null;
	return source.kind === 'x' ? `x:${source.id}` : source.url;
}

/** What the endpoint is asked. The forms send the field's current value, so
 * the pill and the lookup always agree on which post is being read; the
 * backfill page sends the id of a row whose URL is already stored. */
export type SuggestionRequest = { sourcePostUrl: string } | { imageId: number };

/** How long one lookup may hang before the client gives up on it. The endpoint
 * ends its own chain at 22 s (LOOKUP_DEADLINE_MS in +server.ts) and answers a
 * 502 when it does, so a call still open past that has lost the connection,
 * not the classifier; the headroom is for the answer to make it back. Without
 * it a stalled connection left the pill disabled with no way out but a reload. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One POST to /api/admin/tag-suggestions. Never throws: a transport failure
 * (offline, aborted, timed out, blocked) reads as status 0, and a body that is
 * not JSON — a 202 carries no suggestions and a 5xx may carry no JSON at all —
 * reads as null. Both go straight to `fromResponse`, which maps them onto a
 * state.
 */
export async function requestSuggestions(
	payload: SuggestionRequest
): Promise<{ status: number; body: unknown }> {
	try {
		const res = await fetch('/api/admin/tag-suggestions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			body = null;
		}
		return { status: res.status, body };
	} catch {
		return { status: 0, body: null };
	}
}

/** The "Reading the … post" line for a lookup in flight. */
export function readingLabel(kind: SuggestionSource): string {
	return kind === 'bluesky' ? m.admin_tag_suggest_reading_bluesky() : m.admin_tag_suggest_reading_x();
}

/** "Rated safe by entail.dev" and its two siblings. */
export function ratingLabel(rating: EntailRating | null): string {
	return rating === 'explicit'
		? m.admin_tag_suggest_rated_explicit()
		: rating === 'questionable'
			? m.admin_tag_suggest_rated_questionable()
			: m.admin_tag_suggest_rated_safe();
}

/** What the tray shows for a finished state that is not a suggestion: an
 * eyebrow, a sentence, and either Try again, a way back to the login page, or
 * only Dismiss. */
export type Tray = {
	title: string;
	body: string;
	warn: boolean;
	retry: boolean;
	/** A dead session is the one failure another lookup cannot fix; the tray
	 *  offers the login page instead of a Try again. Set only there, so no other
	 *  branch has to remember to say no. */
	signIn?: boolean;
};

/**
 * The tray for every non-suggestion state. The two forms and the backfill page
 * draw the same five outcomes, so the sentences and the "is another click worth
 * it" answer are decided here once rather than in three `{:else if}` chains.
 */
export function trayFor(state: SuggestionState): Tray {
	const unavailable = m.admin_tag_suggest_unavailable_title();
	switch (state.kind) {
		case 'empty':
			return {
				title: m.admin_tag_suggest_empty_title(),
				// Everything it returned was already in the field, so "found nothing"
				// would be a lie about the post. Say what actually happened instead,
				// rather than restating the policy line that sits under the chips.
				body: state.skippedExisting
					? m.admin_tag_suggest_empty_existing_body()
					: state.noImage
						? m.admin_tag_suggest_empty_no_image_body()
						: m.admin_tag_suggest_empty_body(),
				warn: false,
				retry: false
			};
		case 'notReady':
			return {
				title: m.admin_tag_suggest_not_yet_title(),
				body: m.admin_tag_suggest_not_yet_body(),
				warn: true,
				retry: true
			};
		case 'rateLimited':
			return { title: unavailable, body: m.admin_tag_suggest_rate_limited_body(), warn: true, retry: true };
		case 'notFound':
			return { title: unavailable, body: m.admin_tag_suggest_not_found_body(), warn: true, retry: false };
		case 'badLink':
			return { title: unavailable, body: m.admin_tag_suggest_bad_link_body(), warn: true, retry: false };
		case 'signedOut':
			return {
				title: m.admin_tag_suggest_signed_out_title(),
				body: m.admin_tag_suggest_signed_out_body(),
				warn: true,
				retry: false,
				signIn: true
			};
		case 'noSource':
			// The forms answer this under the field, so only the backfill row draws
			// it. Either way the state came from a 422: the client recogniser
			// accepted the link and the server's did not, so this is the same
			// refusal a 400 is, and it borrows that sentence — the site cannot look
			// the link up, which is the truth about a URL nothing was sent for.
			return { title: unavailable, body: m.admin_tag_suggest_bad_link_body(), warn: true, retry: false };
		default:
			// 'unavailable', and the states the tray never renders.
			return { title: unavailable, body: m.admin_tag_suggest_unavailable_body(), warn: true, retry: true };
	}
}

/**
 * The sentence a finished state puts in the live region. Every failure says
 * exactly what its tray says, so the two are read from the same mapping rather
 * than written out twice: the title and the body are joined through a message,
 * so the pause between them is punctuated the way the locale punctuates it.
 *
 * Three states answer differently. A suggestion has no tray, the forms answer
 * `noSource` under the field rather than with the tray's "unavailable" title,
 * and the states with nothing to announce say nothing. A caller that draws the
 * tray for `noSource` too — the backfill row — passes `withTitle` and gets the
 * same "Title. Body" every other failure gets.
 */
export function sentenceFor(next: SuggestionState, { withTitle = false } = {}): string {
	switch (next.kind) {
		case 'suggested':
			return m.admin_tag_suggest_eyebrow({ count: next.tags.length });
		case 'noSource':
			// A 422: the field holds a link the client recogniser accepted and the
			// server's refused, so "add a post URL" would describe a field that is
			// not empty. Nothing was sent for it, so nothing is blamed for it.
			if (!withTitle) return m.admin_tag_suggest_bad_link_body();
			break;
		case 'idle':
		case 'searching':
		case 'applied':
			return '';
	}
	const tray = trayFor(next);
	return m.admin_tag_suggest_status_join({ title: tray.title, body: tray.body });
}

/**
 * Which row Load more should put focus on, given the list as it arrived and the
 * id of the row that was last on screen when the link was clicked.
 *
 * Normally that is the row after the anchor — the first one the click added.
 * When the anchor has been saved off the list since, the top of the list stands
 * in. When the anchor is still the last row (every row that followed it went off
 * the list), there is no row after it, and without falling back to the anchor
 * itself focus would drop to the body.
 */
export function rowToFocusAfter<T extends { id: number }>(
	rows: T[],
	afterId: number
): T | undefined {
	const was = rows.findIndex((row) => row.id === afterId);
	if (was === -1) return rows[0];
	return rows[was + 1] ?? rows[was];
}

/** The tags a suggested state would add, in the classifier's order. */
export function selectedTags(state: SuggestionState): string[] {
	return state.kind === 'suggested' ? state.tags.filter((tag) => !state.leftOut.has(tag)) : [];
}

/** Flip one chip between kept and left out. Returns a new state; the old one is
 * untouched, so Svelte sees an assignment rather than a mutated Set. */
export function toggleTag(state: SuggestionState, tag: string): SuggestionState {
	if (state.kind !== 'suggested') return state;
	const leftOut = new Set(state.leftOut);
	if (leftOut.has(tag)) leftOut.delete(tag);
	else leftOut.add(tag);
	return { ...state, leftOut };
}

/**
 * Append accepted tags to the Tags input's value without disturbing what the
 * operator typed. Entries already in the field are skipped (compared through
 * `sanitizeTag`), and so are duplicates within `accepted`.
 */
export function applyTo(existingInput: string, accepted: string[]): string {
	const kept = parseTagInput(existingInput);
	const seen = new Set(kept.map(sanitizeTag).filter(Boolean));
	for (const tag of accepted) {
		const key = sanitizeTag(tag);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		kept.push(tag);
	}
	return kept.join(', ');
}
