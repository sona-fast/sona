import { describe, it, expect } from 'vitest';
import {
	FUZZYSEARCH_ENDPOINT,
	FUZZYSEARCH_MAX_DISTANCE,
	FUZZYSEARCH_TIMEOUT_MS,
	searchImage,
	normalizeMatches,
	pickPrefillMatch,
	strictestRating,
	normalizeSourceUrl,
	postUrlFor,
	handleProfileUrl,
	findLocalArtists,
	findArtistsByName,
	fuzzysearchRefusedMarker,
	parseFuzzysearchRefusedMarker,
	type LookupMatch
} from './fuzzysearch';

// A fetch stand-in that records what the client sent and answers with a fixed
// response. Injected rather than stubbed globally (the furtrack.test.ts shape).
function fakeFetch(response: Response | (() => Promise<Response>)) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fn = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return typeof response === 'function' ? await response() : response;
	}) as unknown as typeof fetch;
	return { fn, calls };
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const MIXED_PAYLOAD = [
	// Dropped: too far away to be a lead.
	{ site: 'FurAffinity', site_id_str: '999', artists: ['faraway'], distance: 9 },
	{ site: 'Weasyl', site_id_str: '5150', artists: ['kuttoya'], distance: 2, rating: 'mature' },
	{
		site: 'FurAffinity',
		site_id_str: '12345',
		artists: ['kuttoya'],
		distance: 0,
		rating: 'general',
		posted_at: '2026-01-02T03:04:05Z'
	},
	// Dropped: a site with no post-URL shape and nothing to link to.
	{ site: 'Unknown', site_id_str: '1', artists: [], distance: 0 },
	{ site: 'e621', site_id_str: '777', artists: ['kuttoya'], distance: null, rating: 'adult' },
	{ site: 'Twitter', site_id_str: '160', artists: ['kuttoya'], distance: 2, rating: 'adult' },
	// Twitter with no artist handle — the status still has a canonical URL.
	{ site: 'Twitter', site_id_str: '161', artists: [], distance: 5 }
];

describe('normalizeMatches', () => {
	const matches = normalizeMatches(MIXED_PAYLOAD);

	it('drops Unknown sites and anything past the distance cap', () => {
		expect(matches.map((m) => m.siteId)).not.toContain('999');
		expect(matches.some((m) => (m.site as string) === 'Unknown')).toBe(false);
		expect(matches).toHaveLength(5);
	});

	it('sorts closest first, ties by site, nulls last', () => {
		expect(matches.map((m) => `${m.site}:${m.siteId}`)).toEqual([
			'FurAffinity:12345',
			'Twitter:160',
			'Weasyl:5150',
			'Twitter:161',
			'e621:777'
		]);
	});

	it('bands the distances', () => {
		expect(matches[0].band).toBe('exact'); // 0
		expect(matches[1].band).toBe('strong'); // 2
		expect(matches[3].band).toBe('possible'); // 5
		expect(matches[4].band).toBeNull(); // unknown distance
		expect(matches[4].distance).toBeNull();
	});

	it('builds a post URL for every site', () => {
		const byId = Object.fromEntries(matches.map((m) => [m.siteId, m.postUrl]));
		expect(byId['12345']).toBe('https://www.furaffinity.net/view/12345/');
		expect(byId['5150']).toBe('https://www.weasyl.com/submission/5150');
		expect(byId['777']).toBe('https://e621.net/posts/777');
		expect(byId['160']).toBe('https://twitter.com/kuttoya/status/160');
		expect(byId['161']).toBe('https://twitter.com/i/status/161');
	});

	it('keeps the raw handles, the posted date, and a known rating', () => {
		expect(matches[0].handles).toEqual(['kuttoya']);
		expect(matches[0].postedAt).toBe('2026-01-02T03:04:05Z');
		expect(matches[0].rating).toBe('general');
		expect(matches[3].rating).toBeNull();
	});

	it('returns nothing for a payload that is not a list', () => {
		expect(normalizeMatches({ matches: [] })).toEqual([]);
		expect(normalizeMatches(null)).toEqual([]);
	});

	// The cap is the line between a lead and noise, so it is pinned rather than
	// left to whatever the constant happens to be.
	it('keeps a match at the distance cap and drops the one past it', () => {
		const at = normalizeMatches([
			{ site: 'FurAffinity', site_id_str: '7', artists: [], distance: FUZZYSEARCH_MAX_DISTANCE }
		]);
		expect(at.map((m) => m.siteId)).toEqual(['7']);
		expect(at[0].band).toBe('possible');
		expect(
			normalizeMatches([
				{ site: 'FurAffinity', site_id_str: '8', artists: [], distance: FUZZYSEARCH_MAX_DISTANCE + 1 }
			])
		).toEqual([]);
	});

	// Third-party JSON: every field can be the wrong shape, and none of it may
	// throw or reach the operator as a half-built match.
	it('survives junk entries — dropping or nulling each without throwing', () => {
		const junk = normalizeMatches([
			// Negative distance: not a real Hamming distance, so not a lead.
			{ site: 'FurAffinity', site_id_str: '1', distance: -1 },
			// Non-numeric distances read as "unknown", which is allowed.
			{ site: 'FurAffinity', site_id_str: '2', distance: 'close' },
			{ site: 'FurAffinity', site_id_str: '3', distance: Number.NaN },
			// No usable id — nothing to link to.
			{ site: 'FurAffinity', distance: 0 },
			{ site: 'FurAffinity', site_id_str: 12345, distance: 0 },
			// Non-object entries.
			null,
			'FurAffinity',
			42,
			[{ site: 'FurAffinity', site_id_str: '9' }]
		]);

		expect(junk.map((m) => m.siteId)).toEqual(['2', '3']);
		expect(junk.every((m) => m.distance === null && m.band === null)).toBe(true);
	});

	it('keeps only usable handles, and still builds a Twitter URL without one', () => {
		const [match] = normalizeMatches([
			{ site: 'Twitter', site_id_str: '160', artists: ['ok', '', '  ', 42, null], distance: 0 }
		]);
		expect(match.handles).toEqual(['ok']);

		const [junkOnly] = normalizeMatches([
			{ site: 'Twitter', site_id_str: '161', artists: [null, 7], distance: 0 }
		]);
		expect(junkOnly.handles).toEqual([]);
		expect(junkOnly.postUrl).toBe('https://twitter.com/i/status/161');
	});
});

describe('searchImage — request shape', () => {
	it('posts the bytes as multipart with the key header and a timeout signal', async () => {
		const { fn, calls } = fakeFetch(jsonResponse(MIXED_PAYLOAD));
		const result = await searchImage(new Blob([new Uint8Array([1, 2, 3])]), 'secret-key', fn);

		expect(result).toEqual({ ok: true, matches: normalizeMatches(MIXED_PAYLOAD) });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(FUZZYSEARCH_ENDPOINT);
		expect(calls[0].init.method).toBe('POST');
		expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('secret-key');
		expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
		const body = calls[0].init.body as FormData;
		expect(body).toBeInstanceOf(FormData);
		const sent = body.get('image');
		expect(sent).toBeInstanceOf(File);
		expect((sent as File).name).toBe('image');
		// The bound the signal was built with, pinned so it can't silently grow.
		expect(FUZZYSEARCH_TIMEOUT_MS).toBe(8000);
	});
});

describe('searchImage — failure mapping', () => {
	const cases: Array<[number, string]> = [
		[401, 'key_refused'],
		// A revoked or suspended key answers 403, not 401; both are the refused
		// state the settings card can act on.
		[403, 'key_refused'],
		[429, 'rate_limited'],
		[413, 'too_large'],
		[500, 'unavailable'],
		[404, 'unavailable']
	];
	for (const [status, reason] of cases) {
		it(`maps ${status} to ${reason}`, async () => {
			const { fn } = fakeFetch(new Response('nope', { status }));
			expect(await searchImage(new Blob(['x']), 'k', fn)).toEqual({ ok: false, reason });
		});
	}

	it('splits 400 into too_large and invalid_image by body', async () => {
		const big = fakeFetch(new Response('{"error":"too_large"}', { status: 400 }));
		expect(await searchImage(new Blob(['x']), 'k', big.fn)).toEqual({
			ok: false,
			reason: 'too_large'
		});
		const bad = fakeFetch(new Response('{"error":"could not decode"}', { status: 400 }));
		expect(await searchImage(new Blob(['x']), 'k', bad.fn)).toEqual({
			ok: false,
			reason: 'invalid_image'
		});
	});

	it('maps a network error or an aborted request to unavailable', async () => {
		const { fn } = fakeFetch(async () => {
			throw new DOMException('The operation was aborted.', 'TimeoutError');
		});
		expect(await searchImage(new Blob(['x']), 'k', fn)).toEqual({
			ok: false,
			reason: 'unavailable'
		});
	});

	it('maps an unparseable 200 body to unavailable', async () => {
		const { fn } = fakeFetch(new Response('<html>', { status: 200 }));
		expect(await searchImage(new Blob(['x']), 'k', fn)).toEqual({
			ok: false,
			reason: 'unavailable'
		});
	});

	// A 200 carrying something other than the documented array is a broken
	// upstream. Reported as no matches it would read as "your art isn't indexed",
	// which is a different — and wrong — answer.
	it('maps a 200 whose JSON is not an array to unavailable, not an empty list', async () => {
		for (const body of [{ matches: [] }, 'ok', 42, null]) {
			const { fn } = fakeFetch(jsonResponse(body));
			expect(await searchImage(new Blob(['x']), 'k', fn), JSON.stringify(body)).toEqual({
				ok: false,
				reason: 'unavailable'
			});
		}
	});
});

function match(over: Partial<LookupMatch>): LookupMatch {
	return {
		site: 'FurAffinity',
		siteId: '1',
		handles: [],
		distance: 0,
		band: 'exact',
		postedAt: null,
		rating: null,
		postUrl: 'https://www.furaffinity.net/view/1/',
		...over
	};
}

describe('pickPrefillMatch', () => {
	it('takes the first exact or strong match in sorted order', () => {
		const picked = pickPrefillMatch([
			match({ siteId: 'a', distance: 1, band: 'strong' }),
			match({ siteId: 'b', distance: 0, band: 'exact' })
		]);
		expect(picked?.siteId).toBe('a');
	});

	it('is null when nothing is closer than possible', () => {
		expect(pickPrefillMatch([match({ distance: 4, band: 'possible' })])).toBeNull();
		expect(pickPrefillMatch([match({ distance: null, band: null })])).toBeNull();
		expect(pickPrefillMatch([])).toBeNull();
	});
});

describe('strictestRating', () => {
	it('takes the strictest rating across confident matches and names its sites', () => {
		expect(
			strictestRating([
				match({ site: 'FurAffinity', rating: 'general' }),
				match({ site: 'e621', band: 'strong', distance: 2, rating: 'adult' }),
				match({ site: 'Twitter', band: 'strong', distance: 1, rating: 'adult' }),
				match({ site: 'Weasyl', rating: 'mature' })
			])
		).toEqual({ rating: 'adult', sites: ['e621', 'Twitter'] });
	});

	it('ignores possible and unknown-distance matches', () => {
		expect(
			strictestRating([
				match({ rating: 'general' }),
				match({ site: 'e621', band: 'possible', distance: 6, rating: 'adult' }),
				match({ site: 'Weasyl', band: null, distance: null, rating: 'adult' })
			])
		).toEqual({ rating: 'general', sites: ['FurAffinity'] });
	});

	it('is null when no confident match carries a rating', () => {
		expect(strictestRating([match({ rating: null })])).toBeNull();
		expect(strictestRating([])).toBeNull();
	});
});

describe('normalizeSourceUrl', () => {
	it('folds scheme, host case, www, query, fragment, and trailing slash', () => {
		const canonical = 'furaffinity.net/view/12345';
		expect(normalizeSourceUrl('https://www.furaffinity.net/view/12345/')).toBe(canonical);
		expect(normalizeSourceUrl('http://FurAffinity.NET/view/12345')).toBe(canonical);
		expect(normalizeSourceUrl('https://www.furaffinity.net/view/12345?full=1#c')).toBe(canonical);
		expect(normalizeSourceUrl('  https://WWW.furaffinity.net/view/12345//  ')).toBe(canonical);
	});

	// The same post under the site's other name. Without this fold, an operator
	// who saved the x.com link gets no clash warning for the twitter.com URL
	// this client builds.
	it('folds known host aliases onto one canonical host', () => {
		expect(normalizeSourceUrl('https://x.com/kuttoya/status/160')).toBe(
			'twitter.com/i/status/160'
		);
		expect(normalizeSourceUrl('https://mobile.twitter.com/kuttoya/status/160')).toBe(
			'twitter.com/i/status/160'
		);
		expect(normalizeSourceUrl('https://sfw.furaffinity.net/view/12345/')).toBe(
			'furaffinity.net/view/12345'
		);
	});

	// A match with no artist handle gets the /i/ URL this client builds, and the
	// operator's saved link carries the handle. Same tweet, so both must reduce
	// to the same string or the duplicate-source warning never fires.
	it('reduces a tweet to its status id, with or without the handle', () => {
		const canonical = 'twitter.com/i/status/160';
		expect(normalizeSourceUrl('https://twitter.com/i/status/160')).toBe(canonical);
		expect(normalizeSourceUrl('https://twitter.com/kuttoya/status/160')).toBe(canonical);
		expect(normalizeSourceUrl('https://x.com/kuttoya/status/160')).toBe(canonical);
		// The address Twitter's UI hands out for a tweet's image.
		expect(normalizeSourceUrl('https://x.com/kuttoya/status/160/photo/1')).toBe(canonical);
	});

	// A host that names an inherited Object member must be a lookup miss, not
	// whatever the prototype carries under that key.
	it('does not read host aliases through Object.prototype', () => {
		expect(normalizeSourceUrl('http://constructor/view/1')).toBe('constructor/view/1');
		expect(normalizeSourceUrl('http://__proto__/view/1')).toBe('__proto__/view/1');
	});

	it('lowercases the path on the hosts that treat it case-insensitively', () => {
		expect(normalizeSourceUrl('https://twitter.com/Kuttoya')).toBe('twitter.com/kuttoya');
		expect(normalizeSourceUrl('https://www.furaffinity.net/View/12345/')).toBe(
			'furaffinity.net/view/12345'
		);
	});

	it('keeps path case elsewhere, since most sites are case-sensitive there', () => {
		expect(normalizeSourceUrl('https://www.weasyl.com/submission/5150/Some-Title')).toBe(
			'weasyl.com/submission/5150/Some-Title'
		);
	});

	// Each site's other spelling of one submission: FurAffinity's full-size view
	// and e621's old post path both name the post this client builds a canonical
	// URL for.
	it('folds the alternate post paths on FurAffinity and e621', () => {
		expect(normalizeSourceUrl('https://www.furaffinity.net/full/12345/')).toBe(
			'furaffinity.net/view/12345'
		);
		expect(normalizeSourceUrl('https://e621.net/post/show/160')).toBe('e621.net/posts/160');
		// e621's old path carried the tag string after the id, and that is still
		// the same post — folded like a tweet's trailing segment.
		expect(normalizeSourceUrl('https://e621.net/post/show/160/canine%20solo')).toBe(
			'e621.net/posts/160'
		);
		// Only the bare id form folds on FurAffinity: a deeper path is a different
		// page there.
		expect(normalizeSourceUrl('https://www.furaffinity.net/full/12345/extra')).toBe(
			'furaffinity.net/full/12345/extra'
		);
	});

	it('is empty for blank input', () => {
		expect(normalizeSourceUrl('')).toBe('');
		expect(normalizeSourceUrl(null)).toBe('');
		expect(normalizeSourceUrl(undefined)).toBe('');
	});
});

describe('postUrlFor', () => {
	// FuzzySearch hands Twitter handles back spelled either way, and the '@' is
	// not part of the path — left in, it builds a 404 for every tweet.
	it('strips a leading @ from the Twitter handle', () => {
		expect(postUrlFor('Twitter', '160', ['@kuttoya'])).toBe(
			'https://twitter.com/kuttoya/status/160'
		);
		expect(postUrlFor('Twitter', '160', ['kuttoya'])).toBe(
			'https://twitter.com/kuttoya/status/160'
		);
	});

	// Nothing left after stripping is the same as no handle at all.
	it('falls back to the /i/ spelling when the handle is only decoration', () => {
		expect(postUrlFor('Twitter', '160', ['@'])).toBe('https://twitter.com/i/status/160');
		expect(postUrlFor('Twitter', '160', ['  '])).toBe('https://twitter.com/i/status/160');
		expect(postUrlFor('Twitter', '160', [])).toBe('https://twitter.com/i/status/160');
	});
});

describe('handleProfileUrl', () => {
	it('builds profile URLs for the sites we hold a column for', () => {
		expect(handleProfileUrl('FurAffinity', 'kuttoya')).toBe(
			'https://www.furaffinity.net/user/kuttoya/'
		);
		expect(handleProfileUrl('Twitter', '@kuttoya')).toBe('https://twitter.com/kuttoya');
	});

	// A handle is third-party text: unescaped, a slash or a '?' in it re-points
	// the URL at a page the operator did not ask for.
	it('percent-encodes a handle carrying URL syntax', () => {
		expect(handleProfileUrl('FurAffinity', 'evil/../../news')).toBe(
			'https://www.furaffinity.net/user/evil%2F..%2F..%2Fnews/'
		);
		expect(handleProfileUrl('Twitter', 'a?b#c')).toBe('https://twitter.com/a%3Fb%23c');
	});

	it('returns null for sites with no artist column yet, and for a blank handle', () => {
		expect(handleProfileUrl('Weasyl', 'kuttoya')).toBeNull();
		expect(handleProfileUrl('e621', 'kuttoya')).toBeNull();
		expect(handleProfileUrl('FurAffinity', '  ')).toBeNull();
	});
});

describe('findLocalArtists', () => {
	const rows = [
		{ id: 1, name: 'Kuttoya', furAffinityUrl: 'https://www.furaffinity.net/user/KUTTOYA/' },
		{ id: 2, name: 'Someone Else', twitterUrl: 'https://x.com/kuttoya' },
		{ id: 3, name: 'Nobody', furAffinityUrl: '' }
	];

	it('matches a FurAffinity handle case-insensitively', () => {
		const found = findLocalArtists(rows, { site: 'FurAffinity', handles: ['kuttoya'] });
		expect(found.map((r) => r.id)).toEqual([1]);
	});

	it('matches a Twitter handle across host spellings', () => {
		const found = findLocalArtists(rows, { site: 'Twitter', handles: ['Kuttoya'] });
		expect(found.map((r) => r.id)).toEqual([2]);
	});

	// Twitter is where an @-prefixed handle actually arrives, and the stripping
	// moved into normalizeHandle when this matcher was rewritten.
	it('matches a Twitter handle that arrives with its @', () => {
		const found = findLocalArtists(rows, { site: 'Twitter', handles: ['@Kuttoya'] });
		expect(found.map((r) => r.id)).toEqual([2]);
	});

	it('returns nothing for sites with no artist column, or with no handles', () => {
		expect(findLocalArtists(rows, { site: 'Weasyl', handles: ['kuttoya'] })).toEqual([]);
		expect(findLocalArtists(rows, { site: 'e621', handles: ['kuttoya'] })).toEqual([]);
		expect(findLocalArtists(rows, { site: 'FurAffinity', handles: [] })).toEqual([]);
	});
});

describe('findArtistsByName', () => {
	const rows = [{ id: 1, name: 'Kuttoya' }, { id: 2, name: 'kuttoya ' }, { id: 3, name: 'Other' }];

	it('matches exactly, ignoring case, surrounding space, and a leading @', () => {
		expect(findArtistsByName(rows, 'KUTTOYA').map((r) => r.id)).toEqual([1, 2]);
		expect(findArtistsByName(rows, '@kuttoya').map((r) => r.id)).toEqual([1, 2]);
	});

	it('does not match on a substring, or on nothing', () => {
		expect(findArtistsByName(rows, 'kutt')).toEqual([]);
		expect(findArtistsByName(rows, '  ')).toEqual([]);
	});
});

describe('the refused marker', () => {
	it('round-trips the date and the key source', () => {
		const marker = fuzzysearchRefusedMarker('env', new Date('2026-09-01T10:00:00.000Z'));
		expect(marker).toBe('2026-09-01T10:00:00.000Z|env');
		expect(parseFuzzysearchRefusedMarker(marker)).toEqual({
			at: '2026-09-01T10:00:00.000Z',
			source: 'env'
		});
		expect(parseFuzzysearchRefusedMarker(fuzzysearchRefusedMarker('stored'))?.source).toBe('stored');
	});

	it('reads a cleared or missing marker as no refusal', () => {
		expect(parseFuzzysearchRefusedMarker('')).toBeNull();
		expect(parseFuzzysearchRefusedMarker(null)).toBeNull();
		expect(parseFuzzysearchRefusedMarker(undefined)).toBeNull();
	});

	it('reads a marker with no source as a refusal of the stored key', () => {
		expect(parseFuzzysearchRefusedMarker('2026-09-01T10:00:00.000Z')).toEqual({
			at: '2026-09-01T10:00:00.000Z',
			source: 'stored'
		});
	});
});
