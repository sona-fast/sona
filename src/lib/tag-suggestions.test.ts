import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	applyTo,
	fromResponse,
	parseTagInput,
	ratingLabel,
	readingLabel,
	requestSuggestions,
	selectedTags,
	rowToFocusAfter,
	sentenceFor,
	toggleTag,
	trayFor,
	type SuggestionState
} from './tag-suggestions';

// The state machine behind the "Suggest tags" control (SONA-220). Every branch
// is reachable from a status code and a body, so the whole thing is testable
// without a browser — which is the reason it lives outside the component.

const ok = (tags: string[], extra: Record<string, unknown> = {}) => ({
	source: 'bluesky',
	tags,
	rating: 'safe',
	imageCount: 1,
	...extra
});

describe('fromResponse — failure statuses', () => {
	it('reads 202 as not ready rather than as a suggestion', () => {
		// 202 is inside res.ok. Treating it as a payload would render an empty
		// tray as if entail.dev had answered with nothing.
		expect(fromResponse(202, { error: 'not_ready' }, [])).toEqual({ kind: 'notReady' });
	});

	it('maps 404, 429 and 502 onto their own states', () => {
		expect(fromResponse(404, { error: 'not_found' }, [])).toEqual({ kind: 'notFound' });
		expect(fromResponse(429, { error: 'rate_limited' }, [])).toEqual({ kind: 'rateLimited' });
		expect(fromResponse(502, { error: 'unavailable' }, [])).toEqual({ kind: 'unavailable' });
	});

	it('answers an unsupported source by asking for a post URL, not by blaming entail.dev', () => {
		expect(fromResponse(422, { error: 'unsupported_source' }, [])).toEqual({ kind: 'noSource' });
	});

	it('reads a 400 as a link the endpoint refused, not as an entail.dev outage', () => {
		// A URL the endpoint's own length cap rejects passes classifySourceUrl, so
		// the pill runs and the answer is a 400. Another click sends the same link.
		expect(fromResponse(400, { error: 'invalid_request' }, [])).toEqual({ kind: 'badLink' });
		expect(trayFor({ kind: 'badLink' })).toMatchObject({ retry: false, warn: true });
		expect(sentenceFor({ kind: 'badLink' })).toBe(
			"Suggestions unavailable. Sona can't look up this link. Check the source post URL."
		);
	});

	it('reads a 401 as a dead session, and offers the login page instead of a retry', () => {
		// The admin hook answers an expired or revoked session with a 401 and a text
		// body. Falling through to `unavailable` blamed entail.dev and offered a Try
		// again that sends the same dead cookie every time.
		expect(fromResponse(401, null, [])).toEqual({ kind: 'signedOut' });
		expect(trayFor({ kind: 'signedOut' })).toEqual({
			title: 'Signed out',
			body: 'Your session has ended. Sign in again to keep going.',
			warn: true,
			retry: false,
			signIn: true
		});
		expect(sentenceFor({ kind: 'signedOut' })).toBe(
			'Signed out. Your session has ended. Sign in again to keep going.'
		);
	});

	it('treats a transport failure (status 0) as unavailable', () => {
		expect(fromResponse(0, null, [])).toEqual({ kind: 'unavailable' });
	});
});

describe('fromResponse — a 200', () => {
	it('keeps the classifier order and carries the rating and image count', () => {
		const state = fromResponse(200, ok(['mammal', 'canine', 'fox'], { imageCount: 3 }), []);
		expect(state).toMatchObject({
			kind: 'suggested',
			tags: ['mammal', 'canine', 'fox'],
			rating: 'safe',
			imageCount: 3,
			skippedExisting: false
		});
	});

	it('is empty when the post was read but nothing came back', () => {
		// A tweet with no photo, or a post where every tag fell below the floor.
		expect(fromResponse(200, ok([]), [])).toEqual({
			kind: 'empty',
			skippedExisting: false,
			noImage: false
		});
	});

	it('is unavailable when a 200 is not the shape the endpoint answers with', () => {
		// A re-gated fork answers the same URL with an HTML login page, which
		// reads as a null body. "Found nothing" would hide the Try again that
		// works again once the operator is back through the gate.
		expect(fromResponse(200, null, [])).toEqual({ kind: 'unavailable' });
		expect(fromResponse(200, 'not json', [])).toEqual({ kind: 'unavailable' });
		expect(fromResponse(200, { ...ok([]), tags: 'fox' }, [])).toEqual({ kind: 'unavailable' });
		expect(fromResponse(200, {}, [])).toEqual({ kind: 'unavailable' });
	});

	it('flags a post with no picture, which nothing was asked about', () => {
		// An X post that is text, video or a GIF: the endpoint answers 200 with no
		// tags and imageCount 0 without asking entail.dev anything, so crediting
		// the classifier with a verdict would be false.
		expect(fromResponse(200, ok([], { source: 'x', imageCount: 0 }), [])).toEqual({
			kind: 'empty',
			skippedExisting: false,
			noImage: true
		});
	});

	it('does not call a Bluesky post picture-less when entail.dev classified nothing', () => {
		// entail.dev answering with an empty images array is imageCount 0 on the
		// Bluesky path: it looked and classified nothing, which is the opposite of
		// the post having no picture. The tray keeps the general sentence.
		expect(fromResponse(200, ok([], { source: 'bluesky', imageCount: 0 }), [])).toEqual({
			kind: 'empty',
			skippedExisting: false,
			noImage: false
		});
	});

	it('strips control, bidirectional and comma characters from a chip label', () => {
		// The label is drawn from a body that describes somebody else's post. A
		// right-to-left override in it would reorder the text around the chip, and
		// a comma is the Tags field's separator: applyTo would split the accepted
		// tag into two the moment it joined the field back up.
		const state = fromResponse(200, ok(['fo\u202Ex', 'bea\u0007ch', 'sea, sky']), []);
		expect(state).toMatchObject({ kind: 'suggested', tags: ['fox', 'beach', 'sea sky'] });
		expect(applyTo('', selectedTags(state))).toBe('fox, beach, sea sky');
	});

	it('drops tags the Tags field already holds, matched the way the sanitizer does', () => {
		// "Digital Media" in the field and "digital-media" from the classifier are
		// the same tag once saved, so offering it again would add a duplicate.
		const state = fromResponse(200, ok(['digital-media', 'fox']), ['Digital Media']);
		expect(state).toMatchObject({ kind: 'suggested', tags: ['fox'], skippedExisting: true });
	});

	it('is empty when every suggestion is already in the field', () => {
		// Flagged, because "found nothing" would be false: the post had tags and the
		// field already held all of them.
		expect(fromResponse(200, ok(['fox', 'beach']), ['beach', 'fox'])).toEqual({
			kind: 'empty',
			skippedExisting: true,
			noImage: false
		});
	});

	it('drops repeats and non-strings from a body it cannot trust', () => {
		const state = fromResponse(200, ok(['fox', 'FOX', 'fox'] as string[]), []);
		expect(state).toMatchObject({ kind: 'suggested', tags: ['fox'] });
		const junk = fromResponse(200, { tags: ['fox', 42, null, '', '!!!'] }, []);
		expect(junk).toMatchObject({ kind: 'suggested', tags: ['fox'] });
	});

	it('falls back to one image and no rating when the body says something else', () => {
		const state = fromResponse(200, { tags: ['fox'], rating: 'spicy', imageCount: -4 }, []);
		expect(state).toMatchObject({ kind: 'suggested', rating: null, imageCount: 1 });
	});
});

describe('chips', () => {
	const suggested = fromResponse(200, ok(['mammal', 'canine', 'fox']), []) as Extract<
		SuggestionState,
		{ kind: 'suggested' }
	>;

	it('selects every tag until one is clicked off', () => {
		expect(selectedTags(suggested)).toEqual(['mammal', 'canine', 'fox']);
	});

	it('leaves a clicked tag out and puts it back on a second click', () => {
		const off = toggleTag(suggested, 'canine');
		expect(selectedTags(off)).toEqual(['mammal', 'fox']);
		expect(selectedTags(toggleTag(off, 'canine'))).toEqual(['mammal', 'canine', 'fox']);
	});

	it('returns a new state so the old one is never mutated under Svelte', () => {
		const off = toggleTag(suggested, 'canine');
		expect(off).not.toBe(suggested);
		expect(suggested.leftOut.has('canine')).toBe(false);
	});

	it('ignores a toggle in any state that has no chips', () => {
		const idle: SuggestionState = { kind: 'idle' };
		expect(toggleTag(idle, 'fox')).toBe(idle);
		expect(selectedTags(idle)).toEqual([]);
	});
});

describe('the tray a finished state draws', () => {
	// One mapping for the two forms and the backfill rows, so the same answer
	// never reads as two different outcomes on two surfaces.
	it('offers Try again only where another click could answer differently', () => {
		for (const kind of ['notReady', 'rateLimited', 'unavailable'] as const) {
			expect(trayFor({ kind })).toMatchObject({ retry: true });
		}
		for (const kind of ['empty', 'notFound', 'badLink', 'signedOut', 'noSource'] as const) {
			expect(trayFor({ kind })).toMatchObject({ retry: false });
		}
	});

	it('draws the backfill row a tray for a source URL it cannot read', () => {
		// The forms answer this under the field, so only a row reaches it. The
		// state is a 422 either way: the link passed the client recogniser and the
		// server still could not read a post at it, so the sentence names the link
		// rather than asking for a URL the field already holds.
		expect(trayFor({ kind: 'noSource' })).toEqual({
			title: 'Suggestions unavailable',
			body: "Sona can't look up this link. Check the source post URL.",
			warn: true,
			retry: false
		});
	});

	it('warns for every failure, but not for a post with nothing to suggest', () => {
		expect(trayFor({ kind: 'empty' })).toEqual({
			title: 'No tags to suggest',
			body: "entail.dev read the post but found nothing it's confident about.",
			warn: false,
			retry: false
		});
		// The post did have tags; the field already had them. Saying entail.dev
		// found nothing would blame the classifier for the operator's own typing.
		expect(trayFor({ kind: 'empty', skippedExisting: true })).toEqual({
			title: 'No tags to suggest',
			body: 'entail.dev only returned tags that are already in the Tags field.',
			warn: false,
			retry: false
		});
		// Nothing looked at the post, so the tray says what the post is missing
		// rather than what entail.dev concluded.
		expect(trayFor({ kind: 'empty', noImage: true })).toEqual({
			title: 'No tags to suggest',
			body: 'This post has no image for entail.dev to look at.',
			warn: false,
			retry: false
		});
		expect(trayFor({ kind: 'notFound' })).toMatchObject({
			title: 'Suggestions unavailable',
			body: "entail.dev couldn't read this post.",
			warn: true
		});
	});
});

describe('applyTo', () => {
	it('appends to an empty field', () => {
		expect(applyTo('', ['mammal', 'canine'])).toBe('mammal, canine');
	});

	it('keeps what the operator typed, spacing and all, and appends after it', () => {
		expect(applyTo('beach,summer', ['fox'])).toBe('beach, summer, fox');
	});

	it('never adds a tag the field already has', () => {
		// Same rule as the chip filter, so a tag typed after the lookup ran still
		// cannot land twice.
		expect(applyTo('Beach', ['beach', 'fox'])).toBe('Beach, fox');
	});

	it('de-duplicates within the accepted list', () => {
		expect(applyTo('', ['fox', 'fox'])).toBe('fox');
	});

	it('drops an accepted entry that sanitizes to nothing', () => {
		expect(applyTo('fox', ['!!!'])).toBe('fox');
	});

	it('leaves the field alone when nothing was accepted', () => {
		expect(applyTo('fox, beach', [])).toBe('fox, beach');
	});
});

describe('parseTagInput', () => {
	it('splits on commas and drops the blanks a trailing comma leaves', () => {
		expect(parseTagInput(' fox , beach ,, ')).toEqual(['fox', 'beach']);
	});

	it('reads an empty field as no tags', () => {
		expect(parseTagInput('')).toEqual([]);
	});
});

describe('the sentences the live region reads', () => {
	it('names the post being read by its kind', () => {
		expect(readingLabel('bluesky')).toBe('Reading the Bluesky post');
		expect(readingLabel('x')).toBe('Reading the X post');
	});

	it('joins a title and a body with a full stop, not a bare space', () => {
		// Read aloud, "Suggestions unavailable entail.dev is busy" runs the two
		// together; the join message is what puts the pause between them.
		expect(sentenceFor({ kind: 'rateLimited' })).toBe(
			'Suggestions unavailable. entail.dev is busy. Wait a minute and try again.'
		);
		expect(sentenceFor({ kind: 'notReady' })).toBe(
			"No tags yet. entail.dev hasn't read this post yet. Try again in a minute."
		);
		expect(sentenceFor({ kind: 'empty' })).toBe(
			"No tags to suggest. entail.dev read the post but found nothing it's confident about."
		);
		expect(sentenceFor({ kind: 'empty', skippedExisting: true })).toBe(
			'No tags to suggest. entail.dev only returned tags that are already in the Tags field.'
		);
		expect(sentenceFor({ kind: 'empty', noImage: true })).toBe(
			'No tags to suggest. This post has no image for entail.dev to look at.'
		);
		expect(sentenceFor({ kind: 'notFound' })).toBe(
			"Suggestions unavailable. entail.dev couldn't read this post."
		);
		expect(sentenceFor({ kind: 'unavailable' })).toBe(
			"Suggestions unavailable. entail.dev didn't answer. Your tags are unchanged."
		);
	});

	it('counts the suggestions, and says nothing for the states that have no sentence', () => {
		expect(sentenceFor(fromResponse(200, ok(['fox', 'beach']), []))).toBe(
			'2 suggested tags from entail.dev'
		);
		// A 422 answers about the link the field holds, not about a missing one:
		// the client recogniser accepted that link, so "add a post URL" would
		// describe a field that is not empty.
		expect(sentenceFor({ kind: 'noSource' })).toBe(
			"Sona can't look up this link. Check the source post URL."
		);
		expect(sentenceFor({ kind: 'idle' })).toBe('');
		expect(sentenceFor({ kind: 'searching', source: 'x' })).toBe('');
		expect(sentenceFor({ kind: 'applied', count: 3 })).toBe('');
	});

	it('labels every rating, and reads an unknown one as safe', () => {
		// Each label ends its own sentence: on the backfill row it is followed by
		// another one on the same line.
		expect(ratingLabel('explicit')).toBe('Rated explicit by entail.dev.');
		expect(ratingLabel('questionable')).toBe('Rated questionable by entail.dev.');
		expect(ratingLabel('safe')).toBe('Rated safe by entail.dev.');
		expect(ratingLabel(null)).toBe('Rated safe by entail.dev.');
	});
});

describe('requestSuggestions', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('posts the payload as JSON and hands back the status with the parsed body', async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ tags: ['fox'] }), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);

		const answer = await requestSuggestions({ sourcePostUrl: 'https://bsky.app/profile/a/post/b' });
		expect(answer).toEqual({ status: 200, body: { tags: ['fox'] } });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/tag-suggestions');
		expect(init.method).toBe('POST');
		expect(JSON.parse(String(init.body))).toEqual({
			sourcePostUrl: 'https://bsky.app/profile/a/post/b'
		});
	});

	it('reads a body that is not JSON as null, keeping the status', async () => {
		// A 5xx from the platform may carry an HTML error page, not JSON; the
		// status is still what decides the state.
		vi.stubGlobal('fetch', async () => new Response('<html>bad gateway</html>', { status: 502 }));
		expect(await requestSuggestions({ imageId: 7 })).toEqual({ status: 502, body: null });
	});

	it('reads a transport failure as status 0 rather than throwing', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('Failed to fetch');
		});
		expect(await requestSuggestions({ imageId: 7 })).toEqual({ status: 0, body: null });
	});
});

describe('rowToFocusAfter — where Load more lands focus', () => {
	const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];

	it('takes the row after the one that was last on screen', () => {
		expect(rowToFocusAfter(rows, 2)).toEqual({ id: 3 });
	});

	it('keeps focus on the anchor when nothing follows it any more', () => {
		// Every row the click added has since been saved off the list, so there is
		// no row after the anchor. Returning undefined would drop focus to the body.
		expect(rowToFocusAfter(rows, 3)).toEqual({ id: 3 });
	});

	it('falls back to the top of the list when the anchor itself has gone', () => {
		expect(rowToFocusAfter(rows, 99)).toEqual({ id: 1 });
	});

	it('has nothing to focus in an empty list', () => {
		expect(rowToFocusAfter([], 1)).toBeUndefined();
	});
});
