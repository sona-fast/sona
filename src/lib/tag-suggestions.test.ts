import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	applyTo,
	fromResponse,
	parseTagInput,
	requestSuggestions,
	selectedTags,
	rowToFocusAfter,
	sentenceFor,
	sourceKey,
	_REQUEST_TIMEOUT_MS,
	tagsToAdd,
	toggleTag,
	trayFor,
	type SuggestionState
} from './tag-suggestions';
import { classifySourceUrl } from './tags';

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
			noImage: false,
			imageCount: 1,
			rating: 'safe'
		});
	});

	it('carries the image count into the empty state too', () => {
		// A post of four whose first image classified to nothing. The count is what
		// the tray needs to say only one image was read; dropped here, "found
		// nothing" reads as a verdict on the whole post.
		expect(fromResponse(200, ok([], { imageCount: 4 }), [])).toEqual({
			kind: 'empty',
			skippedExisting: false,
			noImage: false,
			imageCount: 4,
			rating: 'safe'
		});
	});

	it('carries the rating into the empty state, which is where it matters most', () => {
		// entail.dev rates the picture; the tags are a separate question. A post it
		// called explicit whose every tag sat under the confidence floor is exactly
		// the one the operator needs the NSFW prompt for, and dropping the rating
		// here made the prompt turn on whether one tag happened to clear the floor.
		expect(fromResponse(200, ok([], { rating: 'explicit' }), [])).toMatchObject({
			kind: 'empty',
			rating: 'explicit'
		});
	});

	it('reads a missing or unknown rating on an empty answer as no rating', () => {
		// Same rule the suggested branch applies: a body is a body, so anything
		// that is not one of the three ratings is none.
		expect(fromResponse(200, ok([], { rating: undefined }), [])).toMatchObject({
			kind: 'empty',
			rating: null
		});
		expect(fromResponse(200, ok([], { rating: 'spicy' }), [])).toMatchObject({
			kind: 'empty',
			rating: null
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
			noImage: true,
			// 0 floors to 1, the way it does on the suggested branch. `noImage` is
			// what carries "the post had no picture"; the count only decides whether
			// the tray says one image out of several was read.
			imageCount: 1,
			rating: 'safe'
		});
	});

	it('does not call a Bluesky post picture-less when entail.dev classified nothing', () => {
		// entail.dev answering with an empty images array is imageCount 0 on the
		// Bluesky path: it looked and classified nothing, which is the opposite of
		// the post having no picture. The tray keeps the general sentence.
		expect(fromResponse(200, ok([], { source: 'bluesky', imageCount: 0 }), [])).toEqual({
			kind: 'empty',
			skippedExisting: false,
			noImage: false,
			imageCount: 1,
			rating: 'safe'
		});
	});

	it('strips control, bidirectional and comma characters from a chip label', () => {
		// The label is drawn from a body that describes somebody else's post. A
		// right-to-left override in it would reorder the text around the chip, and
		// a comma is the Tags field's separator: applyTo would split the accepted
		// tag into two the moment it joined the field back up.
		// U+2028 and a zero-width joiner go the same way: a line separator breaks
		// the chip row, and a joiner makes two different labels look identical.
		// U+0085 is a C1 control, which the range this used to list stopped short
		// of; the control-character property covers the whole block.
		const state = fromResponse(
			200,
			ok(['fo\u202Ex', 'bea\u0007ch', 'sea, sky', 'wo\u2028lf', 'de\u200Der', 'ot\u0085ter']),
			[]
		);
		expect(state).toMatchObject({
			kind: 'suggested',
			tags: ['fox', 'beach', 'sea sky', 'wolf', 'deer', 'otter']
		});
		expect(applyTo('', selectedTags(state))).toBe('fox, beach, sea sky, wolf, deer, otter');
	});

	it('caps a chip label where sanitizeTag caps what it stores', () => {
		// A chip longer than the 50 characters Save keeps would show the operator
		// a tag that is not the one that lands in the field.
		const long = 'a'.repeat(60);
		const state = fromResponse(200, ok([long]), []);
		expect(state).toMatchObject({ kind: 'suggested', tags: ['a'.repeat(50)] });
		// The cap counts what is left after cleaning, not the raw entry.
		const cleaned = fromResponse(200, ok([`\u202E${'b'.repeat(50)}`]), []);
		expect(cleaned).toMatchObject({ kind: 'suggested', tags: ['b'.repeat(50)] });
	});

	it('caps by code point, so the cut never splits an astral character', () => {
		// 49 letters and an emoji is 51 UTF-16 units. Sliced by unit, the chip
		// ended in a lone surrogate; sliced by code point it ends in the emoji.
		const state = fromResponse(200, ok([`${'c'.repeat(49)}\u{1F98A}d`]), []);
		expect(state).toMatchObject({ kind: 'suggested', tags: [`${'c'.repeat(49)}\u{1F98A}`] });
	});

	it('keys a suggestion off its cleaned label, so two entries never share one chip', () => {
		// cleanLabel deletes a tab; sanitizeTag would have turned it into a hyphen.
		// Keyed off the raw entry the pair below produced two chips with the same
		// label, and the keyed {#each} over them threw each_key_duplicate.
		const state = fromResponse(200, ok(['foxkit', 'fox\tkit']), []);
		expect(state).toMatchObject({ kind: 'suggested', tags: ['foxkit'] });
	});

	it('matches a field tag against the cleaned label too', () => {
		// Same disagreement on the other side: 'fox\tkit' IS the 'foxkit' already
		// in the field once the label is cleaned, so it is skipped rather than
		// offered as a second copy of a tag the image has.
		const state = fromResponse(200, ok(['fox\tkit', 'sea']), ['foxkit']);
		expect(state).toMatchObject({ kind: 'suggested', tags: ['sea'], skippedExisting: true });
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
			noImage: false,
			imageCount: 1,
			rating: 'safe'
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
		for (const kind of ['notFound', 'badLink', 'signedOut', 'noSource'] as const) {
			expect(trayFor({ kind })).toMatchObject({ retry: false });
		}
		// Out of the loop because it carries a count the others have no field for.
		expect(trayFor({ kind: 'empty', imageCount: 1, rating: null })).toMatchObject({ retry: false });
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

describe('tagsToAdd', () => {
	// What the Add button counts and what "Sona added N tags" claims. applyTo
	// skips a tag the field already holds, so counting the accepted chips instead
	// says three landed when two did — which is what the operator is told after
	// typing one of the suggested names in themselves between the lookup and the
	// click.
	it('counts only the tags the field does not already hold', () => {
		expect(tagsToAdd('beach', ['fox', 'beach', 'sea'])).toEqual(['fox', 'sea']);
	});

	it('matches an existing tag the way Save would write it', () => {
		// "Digital Media" and "digital-media" are one tag, so accepting the second
		// over the first adds nothing.
		expect(tagsToAdd('Digital Media', ['digital-media'])).toEqual([]);
	});

	it('collapses duplicates inside the accepted list', () => {
		expect(tagsToAdd('', ['fox', 'fox'])).toEqual(['fox']);
	});

	it('drops an entry that sanitizes to nothing', () => {
		expect(tagsToAdd('fox', ['!!!'])).toEqual([]);
	});

	it('agrees with what applyTo actually appends', () => {
		// The count and the field are read from the same rule, so they cannot
		// drift: every tag this returns lands, and no tag it leaves out does.
		const field = 'beach, Fox';
		const accepted = ['fox', 'sea', 'beach', 'sky'];
		const added = tagsToAdd(field, accepted);
		expect(added).toEqual(['sea', 'sky']);
		expect(applyTo(field, accepted)).toBe('beach, Fox, sea, sky');
		expect(parseTagInput(applyTo(field, accepted)).length - parseTagInput(field).length).toBe(
			added.length
		);
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

	it('sends a timeout signal, and reads the abort it raises as status 0', async () => {
		// A connection that hangs left the pill disabled with no way out but a
		// reload. The call now carries a timeout signal; when it fires, fetch
		// rejects with an AbortError, which reads as the same unavailable outcome
		// a dropped connection does, so the tray with Try again appears.
		//
		// The signal has to be the timeout one, at the client's own ceiling: a
		// never-aborting controller signal would also be "an AbortSignal", so the
		// test spies on AbortSignal.timeout and checks the fetch was handed what it
		// made. The mock rejects only once that signal fires, so a call that sent
		// no timeout would hang here instead of passing.
		const controller = new AbortController();
		const timeoutSpy = vi
			.spyOn(AbortSignal, 'timeout')
			.mockImplementation(() => controller.signal);
		const fetchMock = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
						once: true
					});
				})
		);
		vi.stubGlobal('fetch', fetchMock);
		try {
			const pending = requestSuggestions({ imageId: 7 });
			expect(timeoutSpy).toHaveBeenCalledWith(_REQUEST_TIMEOUT_MS);
			// Read out here rather than asserted inside the mock: requestSuggestions
			// catches everything, so an assertion that failed in the callback would
			// be swallowed as a transport failure and the test would pass with no
			// signal sent at all.
			const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
			expect(init.signal).toBe(controller.signal);
			expect(init.signal?.aborted).toBe(false);
			controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
			expect(await pending).toEqual({ status: 0, body: null });
		} finally {
			timeoutSpy.mockRestore();
		}
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

describe('which post a source URL names', () => {
	// TagSuggestions keeps an answer only while the field still names the post it
	// answered, and it compares the two through sourceKey rather than as text:
	// typed one way and pasted another, the same post must not throw the chips
	// away, and a different post must.
	const key = (url: string) => sourceKey(classifySourceUrl(url));
	const POST = 'https://bsky.app/profile/kirin.example/post/3kq7x2abc';

	it('reads the same post out of the forms an operator pastes', () => {
		expect(key(`${POST}/`)).toBe(key(POST));
		expect(key(`${POST}?utm_source=x`)).toBe(key(POST));
		expect(key(` ${POST} `)).toBe(key(POST));
	});

	it('reads one tweet under every handle', () => {
		// The canonical URL keeps the handle, so /i/web/status/<id> from the share
		// sheet and /<handle>/status/<id> from the address bar compare unequal as
		// URLs; the key is the status id.
		expect(key('https://x.com/i/web/status/1789012345678901234')).toBe('x:1789012345678901234');
		expect(key('https://x.com/examplefox/status/1789012345678901234')).toBe('x:1789012345678901234');
		expect(key('https://twitter.com/examplefox/status/1789012345678901234/photo/1')).toBe(
			'x:1789012345678901234'
		);
		expect(key('https://x.com/examplefox/status/1789012345678901235')).not.toBe('x:1789012345678901234');
	});

	it('reads another post, and a field that holds no post, as something else', () => {
		expect(key('https://bsky.app/profile/kirin.example/post/3kq7x2def')).not.toBe(key(POST));
		expect(key('')).toBeNull();
		expect(key('not a post at all')).toBeNull();
		expect(sourceKey(null)).toBeNull();
	});
});
