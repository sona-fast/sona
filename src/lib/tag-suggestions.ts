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

import { sanitizeTag } from '$lib/tags';
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
			source: SuggestionSource;
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
	/** The post was read and there is nothing worth suggesting. */
	| { kind: 'empty' }
	/** 202: queued or still classifying. Retryable. */
	| { kind: 'notReady' }
	/** 502: an upstream failure. Retryable. */
	| { kind: 'unavailable' }
	/** 429: entail.dev's or X's per-IP limit. Retryable. */
	| { kind: 'rateLimited' }
	/** 404: the post could not be read, or the classifier declined it. */
	| { kind: 'notFound' };

/** The shape POST /api/admin/tag-suggestions answers a 200 with. Everything is
 * `unknown` on the way in: this is a response body, not a promise. */
type SuggestionBody = {
	source?: unknown;
	tags?: unknown;
	rating?: unknown;
	imageCount?: unknown;
};

const RATINGS: readonly string[] = ['safe', 'questionable', 'explicit'];

function readRating(value: unknown): EntailRating | null {
	return typeof value === 'string' && RATINGS.includes(value) ? (value as EntailRating) : null;
}

function readSource(value: unknown): SuggestionSource {
	// Only two kinds exist, and the pill would not have been enabled for
	// anything else; 'bluesky' is the safe read of a body we cannot trust.
	return value === 'x' ? 'x' : 'bluesky';
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
	// 422 is "this URL is not a Bluesky or X post". The pill should not have
	// been clickable, so say what would make it clickable rather than blaming
	// entail.dev for an answer it never gave.
	if (status === 422) return { kind: 'noSource' };
	if (status !== 200) return { kind: 'unavailable' };

	const payload = (body ?? {}) as SuggestionBody;
	const raw = Array.isArray(payload.tags) ? payload.tags : [];
	const already = new Set(existingTags.map(sanitizeTag).filter(Boolean));

	const tags: string[] = [];
	const seen = new Set<string>();
	let skippedExisting = false;
	for (const entry of raw) {
		if (typeof entry !== 'string') continue;
		const key = sanitizeTag(entry);
		if (!key) continue;
		if (already.has(key)) {
			skippedExisting = true;
			continue;
		}
		// The endpoint already dedupes, but the input is a response body.
		if (seen.has(key)) continue;
		seen.add(key);
		tags.push(entry);
	}

	if (tags.length === 0) return { kind: 'empty' };

	const count = Number(payload.imageCount);
	return {
		kind: 'suggested',
		source: readSource(payload.source),
		tags,
		leftOut: new Set(),
		rating: readRating(payload.rating),
		imageCount: Number.isInteger(count) && count > 0 ? count : 1,
		skippedExisting
	};
}

/** What the endpoint is asked. The forms send the field's current value, so
 * the pill and the lookup always agree on which post is being read; the
 * backfill page sends the id of a row whose URL is already stored. */
export type SuggestionRequest = { sourcePostUrl: string } | { imageId: number };

/**
 * One POST to /api/admin/tag-suggestions. Never throws: a transport failure
 * (offline, aborted, blocked) reads as status 0, and a body that is not JSON —
 * a 202 carries no suggestions and a 5xx may carry no JSON at all — reads as
 * null. Both go straight to `fromResponse`, which maps them onto a state.
 */
export async function requestSuggestions(
	payload: SuggestionRequest
): Promise<{ status: number; body: unknown }> {
	try {
		const res = await fetch('/api/admin/tag-suggestions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
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

/**
 * The sentence a finished state puts in the live region. A title and a body
 * are joined through a message rather than a space, so the pause between them
 * is punctuated the way the locale punctuates it.
 */
export function sentenceFor(next: SuggestionState): string {
	const join = (title: string, body: string) => m.admin_tag_suggest_status_join({ title, body });
	switch (next.kind) {
		case 'suggested':
			return m.admin_tag_suggest_eyebrow({ count: next.tags.length });
		case 'empty':
			return join(m.admin_tag_suggest_empty_title(), m.admin_tag_suggest_empty_body());
		case 'notReady':
			return join(m.admin_tag_suggest_not_yet_title(), m.admin_tag_suggest_not_yet_body());
		case 'rateLimited':
			return join(m.admin_tag_suggest_unavailable_title(), m.admin_tag_suggest_rate_limited_body());
		case 'notFound':
			return join(m.admin_tag_suggest_unavailable_title(), m.admin_tag_suggest_not_found_body());
		case 'unavailable':
			return join(m.admin_tag_suggest_unavailable_title(), m.admin_tag_suggest_unavailable_body());
		case 'noSource':
			return m.admin_tag_suggest_hint_no_source();
		default:
			return '';
	}
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
