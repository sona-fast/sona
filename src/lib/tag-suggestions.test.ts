import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	applyTo,
	fromResponse,
	parseTagInput,
	ratingLabel,
	readingLabel,
	requestSuggestions,
	selectedTags,
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
		expect(fromResponse(200, ok([]), [])).toEqual({ kind: 'empty' });
	});

	it('drops tags the Tags field already holds, matched the way the sanitizer does', () => {
		// "Digital Media" in the field and "digital-media" from the classifier are
		// the same tag once saved, so offering it again would add a duplicate.
		const state = fromResponse(200, ok(['digital-media', 'fox']), ['Digital Media']);
		expect(state).toMatchObject({ kind: 'suggested', tags: ['fox'], skippedExisting: true });
	});

	it('is empty when every suggestion is already in the field', () => {
		expect(fromResponse(200, ok(['fox', 'beach']), ['beach', 'fox'])).toEqual({ kind: 'empty' });
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
		// The forms answer this under the field, so only a row reaches it — an image
		// whose stored URL was edited into something unreadable since the list
		// loaded. Without a tray the row said nothing at all.
		expect(trayFor({ kind: 'noSource' })).toEqual({
			title: 'Suggestions unavailable',
			body: 'Add a Bluesky or X post as the source URL to get tag suggestions.',
			warn: true,
			retry: false,
			signIn: false
		});
	});

	it('warns for every failure, but not for a post with nothing to suggest', () => {
		expect(trayFor({ kind: 'empty' })).toEqual({
			title: 'No tags to suggest',
			body: "entail.dev read the post but found nothing it's confident about.",
			warn: false,
			retry: false,
			signIn: false
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
