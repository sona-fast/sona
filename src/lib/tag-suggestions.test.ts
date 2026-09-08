import { describe, it, expect } from 'vitest';
import {
	applyTo,
	fromResponse,
	parseTagInput,
	selectedTags,
	toggleTag,
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

	it('treats a 400 and a transport failure (status 0) as unavailable', () => {
		expect(fromResponse(400, { error: 'invalid_request' }, [])).toEqual({ kind: 'unavailable' });
		expect(fromResponse(0, null, [])).toEqual({ kind: 'unavailable' });
	});
});

describe('fromResponse — a 200', () => {
	it('keeps the classifier order and carries the rating and image count', () => {
		const state = fromResponse(200, ok(['mammal', 'canine', 'fox'], { imageCount: 3 }), []);
		expect(state).toMatchObject({
			kind: 'suggested',
			source: 'bluesky',
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
		expect(state).toMatchObject({ kind: 'suggested', rating: null, imageCount: 1, source: 'bluesky' });
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
