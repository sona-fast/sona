import { describe, it, expect, vi } from 'vitest';
import { FUZZYSEARCH_MAX_DISTANCE } from './fuzzysearch';
import {
	BLUESKY_PROFILES_ENDPOINT,
	BLUESKY_PROFILES_MAX_ACTORS,
	BLUESKY_PROFILES_RESPONSE_BYTES,
	BLUESKY_PROFILES_TIMEOUT_MS,
	SKYSEEK_ENDPOINT,
	SKYSEEK_RESPONSE_BYTES,
	SKYSEEK_TIMEOUT_MS,
	isOwnBlueskyPost,
	lookupUserAgent,
	normalizeSkyseekMatches,
	resolveBlueskyHandles,
	searchSkyseek,
	skyseekLookupMatch
} from './skyseek';
import { blueskyPostUrl, findLocalArtists, pickPrefillMatch, strictestRating } from './fuzzysearch';

// Injected rather than stubbed globally (the fuzzysearch.test.ts shape).
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

// Made-up accounts in the real DID shape. The response shape itself is the one
// the live endpoint returned for a single image on 2026-11-16.
const ARTIST = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const REPOSTER = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = Date.UTC(2026, 10, 16);
// 2026-10-03T02:15:28Z and a day later, in the seconds the endpoint sends.
const FIRST = 1790993728;
const LATER = FIRST + 86_400;

function answer(...matches: unknown[]) {
	return { success: true, results: [matches] };
}

describe('normalizeSkyseekMatches', () => {
	it('turns a hit into a dated match with a bsky.app post link', () => {
		const matches = normalizeSkyseekMatches(
			answer({ created_at: FIRST, distance: 0, repo: ARTIST, rkey: '3mwwswjznmk25' }),
			NOW
		);
		expect(matches).toEqual([
			{
				did: ARTIST,
				rkey: '3mwwswjznmk25',
				distance: 0,
				postedAt: '2026-10-03T02:15:28.000Z',
				postUrl: `https://bsky.app/profile/${ARTIST}/post/3mwwswjznmk25`
			}
		]);
	});

	it('puts the earliest post first and an undated one last', () => {
		const matches = normalizeSkyseekMatches(
			answer(
				{ repo: REPOSTER, rkey: 'undated' },
				{ created_at: LATER, repo: REPOSTER, rkey: 'later' },
				{ created_at: FIRST, repo: ARTIST, rkey: 'first' }
			),
			NOW
		);
		expect(matches?.map((x) => x.rkey)).toEqual(['first', 'later', 'undated']);
	});

	it('answers an image with no hits as an empty list, not a failure', () => {
		expect(normalizeSkyseekMatches({ success: true, results: [[]] }, NOW)).toEqual([]);
	});

	it('reads only the first image’s list', () => {
		const matches = normalizeSkyseekMatches(
			{
				success: true,
				results: [
					[{ created_at: FIRST, repo: ARTIST, rkey: 'mine' }],
					[{ created_at: FIRST, repo: REPOSTER, rkey: 'another-image' }]
				]
			},
			NOW
		);
		expect(matches?.map((x) => x.rkey)).toEqual(['mine']);
	});

	it.each([
		['null', null],
		['an HTML fragment', '<article>…</article>'],
		['a bare array', [[{ repo: ARTIST, rkey: 'a' }]]],
		['success: false', { success: false, results: [[]] }],
		['no results', { success: true }],
		['results that is not a list', { success: true, results: {} }],
		['no list for the image', { success: true, results: [] }],
		['a list entry that is not a list', { success: true, results: [{ repo: ARTIST, rkey: 'a' }] }]
	])('reports %s as not an answer', (_name, payload) => {
		expect(normalizeSkyseekMatches(payload, NOW)).toBeNull();
	});

	it.each([
		['a repo that is not a DID', { repo: 'evil.example/x', rkey: 'a' }],
		['a DID that carries a path', { repo: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/../x', rkey: 'a' }],
		['a DID method Bluesky does not use', { repo: 'did:key:z6Mk', rkey: 'a' }],
		['a record key with a slash', { repo: ARTIST, rkey: 'a/../../settings' }],
		['a record key with a query', { repo: ARTIST, rkey: 'a?x=1' }],
		['an empty record key', { repo: ARTIST, rkey: '' }],
		['a missing repo', { rkey: 'a' }],
		['a non-object entry', 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa']
	])('drops %s', (_name, entry) => {
		const matches = normalizeSkyseekMatches(
			answer(entry, { created_at: FIRST, repo: ARTIST, rkey: 'good' }),
			NOW
		);
		expect(matches?.map((x) => x.rkey)).toEqual(['good']);
	});

	it('keeps a did:web account', () => {
		const matches = normalizeSkyseekMatches(
			answer({ created_at: FIRST, repo: 'did:web:artist.example', rkey: 'a' }),
			NOW
		);
		expect(matches?.[0].postUrl).toBe('https://bsky.app/profile/did:web:artist.example/post/a');
	});

	it.each([
		['a string', '2026-10-03'],
		['NaN', Number.NaN],
		['milliseconds', FIRST * 1000],
		['a date before Bluesky existed', 0],
		['a date well in the future', NOW / 1000 + 10 * 86_400]
	])('keeps the match but shows no date for %s', (_name, created_at) => {
		const matches = normalizeSkyseekMatches(answer({ created_at, repo: ARTIST, rkey: 'a' }), NOW);
		expect(matches).toHaveLength(1);
		expect(matches?.[0].postedAt).toBeNull();
	});

	it('folds a post that comes back twice into one row, keeping its date', () => {
		const matches = normalizeSkyseekMatches(
			answer(
				{ repo: ARTIST, rkey: 'same' },
				{ created_at: FIRST, repo: ARTIST, rkey: 'same' },
				{ created_at: LATER, repo: REPOSTER, rkey: 'same' }
			),
			NOW
		);
		// The reposter's row shares the key but not the account, so it stays.
		expect(matches).toHaveLength(2);
		expect(matches?.[0]).toMatchObject({ did: ARTIST, postedAt: '2026-10-03T02:15:28.000Z' });
	});
});

describe('searchSkyseek — request shape', () => {
	it('posts the bytes as multipart, asks for JSON, and sends no key', async () => {
		const payload = answer({ created_at: FIRST, repo: ARTIST, rkey: 'a' });
		const { fn, calls } = fakeFetch(jsonResponse(payload));
		const result = await searchSkyseek(new Blob([new Uint8Array([1, 2, 3])]), fn);

		expect(result.ok).toBe(true);
		expect(result.ok && result.matches.map((x) => x.rkey)).toEqual(['a']);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(SKYSEEK_ENDPOINT);
		expect(calls[0].init.method).toBe('POST');
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.accept).toBe('application/json');
		// Who is asking, and nothing that authenticates anyone.
		expect(Object.keys(headers)).toEqual(['accept', 'user-agent']);
		expect(headers['user-agent']).toBe(lookupUserAgent());
		// Following a redirect would replay the image at the Location host.
		expect(calls[0].init.redirect).toBe('manual');
		const sent = (calls[0].init.body as FormData).get('image');
		expect(sent).toBeInstanceOf(File);
		expect((sent as File).size).toBe(3);
	});

	it('hands fetch a signal that aborts at the timeout, not one that never fires', async () => {
		vi.useFakeTimers();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
			return controller.signal;
		});
		try {
			const { fn, calls } = fakeFetch(jsonResponse(answer()));
			await searchSkyseek(new Blob(['x']), fn);

			const signal = calls[0].init.signal as AbortSignal;
			vi.advanceTimersByTime(SKYSEEK_TIMEOUT_MS - 1);
			expect(signal.aborted).toBe(false);
			vi.advanceTimersByTime(2);
			expect(signal.aborted).toBe(true);
		} finally {
			timeout.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe('searchSkyseek — failure mapping', () => {
	it.each([
		[429, 'rate_limited'],
		[413, 'too_large'],
		[400, 'invalid_image'],
		[415, 'invalid_image'],
		[422, 'invalid_image'],
		[403, 'unavailable'],
		[500, 'unavailable'],
		[302, 'unavailable']
	])('answers a %i as %s', async (status, reason) => {
		const { fn } = fakeFetch(new Response('nope', { status }));
		expect(await searchSkyseek(new Blob(['x']), fn)).toEqual({ ok: false, reason });
	});

	it('makes one request and does not retry a 429', async () => {
		const { fn, calls } = fakeFetch(new Response('', { status: 429 }));
		await searchSkyseek(new Blob(['x']), fn);
		expect(calls).toHaveLength(1);
	});

	it('answers a network error or a timeout as unavailable', async () => {
		const { fn } = fakeFetch(async () => {
			throw new TypeError('fetch failed');
		});
		expect(await searchSkyseek(new Blob(['x']), fn)).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('answers a 200 with the HTML fragment as unavailable, not as no matches', async () => {
		const { fn } = fakeFetch(
			new Response('<article>No results</article>', {
				status: 200,
				headers: { 'content-type': 'text/html' }
			})
		);
		expect(await searchSkyseek(new Blob(['x']), fn)).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('answers a 200 that says it failed as unavailable', async () => {
		const { fn } = fakeFetch(jsonResponse({ success: false, results: [] }));
		expect(await searchSkyseek(new Blob(['x']), fn)).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('answers a real search with no hits as an empty match list', async () => {
		const { fn } = fakeFetch(jsonResponse(answer()));
		expect(await searchSkyseek(new Blob(['x']), fn)).toEqual({ ok: true, matches: [] });
	});

	it('stops reading a body that runs past the cap and answers unavailable', async () => {
		const state = { pulled: 0, cancelled: false };
		const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				state.pulled++;
				controller.enqueue(chunk);
			},
			cancel() {
				state.cancelled = true;
			}
		});
		const { fn } = fakeFetch(new Response(body, { status: 200 }));

		expect(await searchSkyseek(new Blob(['x']), fn)).toEqual({ ok: false, reason: 'unavailable' });
		expect(state.cancelled).toBe(true);
		// An endless body, so the read stopping near the cap is the whole point.
		expect(state.pulled * chunk.length).toBeLessThan(SKYSEEK_RESPONSE_BYTES * 2);
	});
});

/** A made-up DID in the did:plc shape, one per index. */
function didAt(index: number): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
	return `did:plc:${alphabet[index % 32].repeat(23)}${alphabet[Math.floor(index / 32) % 32]}`;
}

function profiles(...entries: unknown[]) {
	return { profiles: entries };
}

describe('resolveBlueskyHandles', () => {
	it('asks once, for the DIDs alone, and maps each to its handle', async () => {
		const { fn, calls } = fakeFetch(
			jsonResponse(
				profiles(
					{ did: ARTIST, handle: 'artist.example', displayName: 'An Artist' },
					{ did: REPOSTER, handle: 'reposter.example' }
				)
			)
		);
		const handles = await resolveBlueskyHandles([ARTIST, REPOSTER], fn);

		expect([...handles]).toEqual([
			[ARTIST, 'artist.example'],
			[REPOSTER, 'reposter.example']
		]);
		expect(calls).toHaveLength(1);
		const url = new URL(calls[0].url);
		expect(url.origin + url.pathname).toBe(BLUESKY_PROFILES_ENDPOINT);
		// Nothing rides along but the accounts being asked about.
		expect([...url.searchParams.keys()].every((key) => key === 'actors')).toBe(true);
		expect(url.searchParams.getAll('actors')).toEqual([ARTIST, REPOSTER]);
		expect(calls[0].init.method ?? 'GET').toBe('GET');
		expect(calls[0].init.body).toBeUndefined();
		expect(calls[0].init.redirect).toBe('manual');
		expect(Object.keys(calls[0].init.headers as Record<string, string>)).toEqual([
			'accept',
			'user-agent'
		]);
	});

	it('asks about an account once however many of its posts matched', async () => {
		const { fn, calls } = fakeFetch(jsonResponse(profiles()));
		await resolveBlueskyHandles([ARTIST, ARTIST, REPOSTER, ARTIST], fn);
		expect(new URL(calls[0].url).searchParams.getAll('actors')).toEqual([ARTIST, REPOSTER]);
	});

	it('makes no request when there is nobody to ask about', async () => {
		const { fn, calls } = fakeFetch(jsonResponse(profiles()));
		expect((await resolveBlueskyHandles([], fn)).size).toBe(0);
		expect((await resolveBlueskyHandles(['not-a-did', 'did:key:z6Mk'], fn)).size).toBe(0);
		expect(calls).toEqual([]);
	});

	it('sends at most one call’s worth of DIDs and leaves the rest unresolved', async () => {
		const dids = Array.from({ length: BLUESKY_PROFILES_MAX_ACTORS + 5 }, (_, i) => didAt(i));
		const { fn, calls } = fakeFetch(
			jsonResponse(profiles(...dids.map((did, i) => ({ did, handle: `artist${i}.example` }))))
		);
		const handles = await resolveBlueskyHandles(dids, fn);

		expect(calls).toHaveLength(1);
		expect(new URL(calls[0].url).searchParams.getAll('actors')).toEqual(
			dids.slice(0, BLUESKY_PROFILES_MAX_ACTORS)
		);
		// The answer named all thirty; only the ones asked about are believed.
		expect(handles.size).toBe(BLUESKY_PROFILES_MAX_ACTORS);
		expect(handles.has(dids[BLUESKY_PROFILES_MAX_ACTORS])).toBe(false);
	});

	it('keeps the accounts that resolved when others did not', async () => {
		const { fn } = fakeFetch(jsonResponse(profiles({ did: REPOSTER, handle: 'reposter.example' })));
		const handles = await resolveBlueskyHandles([ARTIST, REPOSTER], fn);
		expect([...handles]).toEqual([[REPOSTER, 'reposter.example']]);
	});

	it('ignores a profile for an account nobody asked about', async () => {
		const { fn } = fakeFetch(
			jsonResponse(profiles({ did: 'did:plc:cccccccccccccccccccccccc', handle: 'stranger.example' }))
		);
		expect((await resolveBlueskyHandles([ARTIST], fn)).size).toBe(0);
	});

	it.each([
		['a path', 'artist.example/../settings'],
		['a query', 'artist.example?x=1'],
		['a scheme', 'javascript:alert(1)'],
		['markup', '<b>artist.example</b>'],
		['whitespace', 'artist .example'],
		['a control character', 'artist.example\u0000'],
		['a single label', 'localhost'],
		['a numeric last label', 'artist.123'],
		['the placeholder for a handle that no longer resolves', 'handle.invalid'],
		['an over-long name', `${'a'.repeat(60)}.`.repeat(5) + 'example'],
		['a non-string', 42],
		['nothing', undefined]
	])('drops a handle that is %s, and keeps the others', async (_name, handle) => {
		const { fn } = fakeFetch(
			jsonResponse(
				profiles({ did: ARTIST, handle }, { did: REPOSTER, handle: 'reposter.example' })
			)
		);
		const handles = await resolveBlueskyHandles([ARTIST, REPOSTER], fn);
		expect([...handles]).toEqual([[REPOSTER, 'reposter.example']]);
	});

	it.each([
		['a 400', () => new Response('{"error":"InvalidRequest"}', { status: 400 })],
		['a 429', () => new Response('', { status: 429 })],
		['a 500', () => new Response('', { status: 500 })],
		['a redirect', () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } })],
		['a body that is not JSON', () => new Response('<html>', { status: 200 })],
		['a body with no profiles list', () => jsonResponse({ profiles: { did: ARTIST } })],
		['a bare list', () => jsonResponse([{ did: ARTIST, handle: 'artist.example' }])],
		['null', () => jsonResponse(null)]
	])('answers %s with no handles, and does not throw', async (_name, response) => {
		const { fn, calls } = fakeFetch(response());
		expect((await resolveBlueskyHandles([ARTIST], fn)).size).toBe(0);
		expect(calls).toHaveLength(1);
	});

	it('answers a network error or a timeout with no handles', async () => {
		const { fn } = fakeFetch(async () => {
			throw new TypeError('fetch failed');
		});
		expect((await resolveBlueskyHandles([ARTIST], fn)).size).toBe(0);
	});

	it('hands fetch a signal that aborts at its own, shorter timeout', async () => {
		vi.useFakeTimers();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
			return controller.signal;
		});
		try {
			const { fn, calls } = fakeFetch(jsonResponse(profiles()));
			await resolveBlueskyHandles([ARTIST], fn);

			const signal = calls[0].init.signal as AbortSignal;
			vi.advanceTimersByTime(BLUESKY_PROFILES_TIMEOUT_MS - 1);
			expect(signal.aborted).toBe(false);
			vi.advanceTimersByTime(2);
			expect(signal.aborted).toBe(true);
		} finally {
			timeout.mockRestore();
			vi.useRealTimers();
		}
	});

	it('stops reading a body that runs past the cap', async () => {
		const state = { pulled: 0, cancelled: false };
		const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				state.pulled++;
				controller.enqueue(chunk);
			},
			cancel() {
				state.cancelled = true;
			}
		});
		const { fn } = fakeFetch(new Response(body, { status: 200 }));

		expect((await resolveBlueskyHandles([ARTIST], fn)).size).toBe(0);
		expect(state.cancelled).toBe(true);
		expect(state.pulled * chunk.length).toBeLessThan(BLUESKY_PROFILES_RESPONSE_BYTES * 2);
	});
});

describe('skyseekLookupMatch', () => {
	const post = {
		did: ARTIST,
		rkey: '3mwwswjznmk25',
		distance: null as number | null,
		postedAt: '2026-10-03T02:15:28.000Z',
		postUrl: blueskyPostUrl(ARTIST, '3mwwswjznmk25')
	};

	it('is a Bluesky row that names the poster and links the post', () => {
		expect(skyseekLookupMatch(post, 'artist.example')).toEqual({
			site: 'Bluesky',
			siteId: `${ARTIST}/3mwwswjznmk25`,
			handles: ['artist.example'],
			distance: null,
			band: null,
			postedAt: '2026-10-03T02:15:28.000Z',
			rating: null,
			postUrl: `https://bsky.app/profile/${ARTIST}/post/3mwwswjznmk25`
		});
	});

	it('stays in the list with no handle, still linked by its DID', () => {
		const row = skyseekLookupMatch(post, null);
		expect(row.handles).toEqual([]);
		expect(row.postUrl).toContain(ARTIST);
	});

	it('gives two posts by one account two different ids', () => {
		const other = { ...post, rkey: 'another' };
		expect(skyseekLookupMatch(post, null).siteId).not.toBe(skyseekLookupMatch(other, null).siteId);
	});

	// Skyseek's distance is on FuzzySearch's scale, so it is banded the same way.
	it.each([
		[0, 'exact'],
		[1, 'strong'],
		[2, 'strong'],
		[3, 'possible'],
		[7, 'possible'],
		[null, null]
	] as const)('bands a distance of %j as %j', (distance, band) => {
		const row = skyseekLookupMatch({ ...post, distance }, 'artist.example');
		expect(row.distance).toBe(distance);
		expect(row.band).toBe(band);
	});

	it('can be the match the form is filled from when it is exact or strong', () => {
		const exact = skyseekLookupMatch({ ...post, distance: 0 }, 'artist.example');
		expect(pickPrefillMatch([exact])).toBe(exact);
		const strong = skyseekLookupMatch({ ...post, distance: 2 }, null);
		expect(pickPrefillMatch([strong])).toBe(strong);
	});

	it('stays a lead, never filled from, when it is loose or has no distance', () => {
		expect(pickPrefillMatch([skyseekLookupMatch({ ...post, distance: 3 }, 'a.example')])).toBeNull();
		expect(pickPrefillMatch([skyseekLookupMatch(post, 'a.example')])).toBeNull();
	});

	// Skyseek reports no rating, so however close the match it suggests no flag.
	it('never rates the piece, even as an exact match', () => {
		expect(strictestRating([skyseekLookupMatch({ ...post, distance: 0 }, null)])).toBeNull();
	});

	it('matches a local artist through their stored Bluesky link, in any spelling', () => {
		const artists = [
			{ id: 1, name: 'By link', blueskyUrl: 'https://bsky.app/profile/Artist.Example' },
			{ id: 2, name: 'By bare handle', blueskyUrl: '@artist.example' },
			{ id: 3, name: 'Someone else', blueskyUrl: 'https://bsky.app/profile/other.example' },
			// The same name on another platform is another account.
			{ id: 4, name: 'Other platform', twitterUrl: 'https://twitter.com/artist.example' }
		];
		const row = skyseekLookupMatch(post, 'artist.example');
		expect(findLocalArtists(artists, row).map((a) => a.id)).toEqual([1, 2]);
		expect(findLocalArtists(artists, skyseekLookupMatch(post, null))).toEqual([]);
	});
});

describe('isOwnBlueskyPost', () => {
	const post = {
		did: ARTIST,
		rkey: 'a',
		distance: 0,
		postedAt: null,
		postUrl: blueskyPostUrl(ARTIST, 'a')
	};
	const mine = skyseekLookupMatch(post, 'operator.example');

	it.each([
		['a profile link', 'https://bsky.app/profile/operator.example'],
		['a link in another letter case', 'https://bsky.app/profile/Operator.Example/'],
		['a bare handle', 'operator.example'],
		['an @handle', '@operator.example']
	])('recognises the operator’s account saved as %s', (_name, saved) => {
		expect(isOwnBlueskyPost(mine, saved)).toBe(true);
	});

	it('recognises it by DID, with or without a resolved handle', () => {
		const saved = `https://bsky.app/profile/${ARTIST}`;
		expect(isOwnBlueskyPost(mine, saved)).toBe(true);
		expect(isOwnBlueskyPost(skyseekLookupMatch(post, null), saved)).toBe(true);
	});

	it('leaves everyone else’s posts alone', () => {
		expect(isOwnBlueskyPost(mine, 'https://bsky.app/profile/someone.example')).toBe(false);
		expect(isOwnBlueskyPost(mine, `https://bsky.app/profile/${REPOSTER}`)).toBe(false);
		// A handle that only starts the same way is another account.
		expect(isOwnBlueskyPost(mine, 'operator.example.evil.example')).toBe(false);
	});

	it.each([['an empty setting', ''], ['a blank one', '   '], ['null', null], ['undefined', undefined]])(
		'drops nothing with %s',
		(_name, saved) => {
			expect(isOwnBlueskyPost(mine, saved)).toBe(false);
			expect(isOwnBlueskyPost(skyseekLookupMatch(post, null), saved)).toBe(false);
		}
	);

	it('never drops a match from another site, whatever its handle', () => {
		const twitter = { site: 'Twitter' as const, siteId: '1', handles: ['operator.example'] };
		expect(isOwnBlueskyPost(twitter, 'operator.example')).toBe(false);
	});
});

describe('normalizeSkyseekMatches — distance', () => {
	const hit = (over: Record<string, unknown>) => ({ created_at: FIRST, repo: ARTIST, rkey: 'a', ...over });

	it.each([
		['missing', {}],
		['negative', { distance: -1 }],
		['NaN', { distance: Number.NaN }],
		['infinite', { distance: Number.POSITIVE_INFINITY }],
		['a string', { distance: '0' }],
		['null', { distance: null }],
		['a boolean', { distance: true }]
	])('keeps a match whose distance is %s, with no distance to claim', (_name, over) => {
		const matches = normalizeSkyseekMatches(answer(hit(over)), NOW);
		expect(matches).toHaveLength(1);
		expect(matches?.[0].distance).toBeNull();
	});

	it('keeps a match at the distance cap and drops the one past it', () => {
		const matches = normalizeSkyseekMatches(
			answer(
				hit({ rkey: 'at-cap', distance: FUZZYSEARCH_MAX_DISTANCE }),
				hit({ rkey: 'past-cap', distance: FUZZYSEARCH_MAX_DISTANCE + 1 }),
				hit({ rkey: 'far', distance: 40 })
			),
			NOW
		);
		expect(matches?.map((x) => [x.rkey, x.distance])).toEqual([['at-cap', FUZZYSEARCH_MAX_DISTANCE]]);
	});

	it('puts the closest first, then the earliest, with an unknown distance last', () => {
		const matches = normalizeSkyseekMatches(
			answer(
				// Earliest of all, but nothing says how close it is.
				{ created_at: FIRST - 86_400, repo: REPOSTER, rkey: 'unknown' },
				{ created_at: FIRST, repo: REPOSTER, rkey: 'loose', distance: 4 },
				{ created_at: LATER, repo: REPOSTER, rkey: 'exact-later', distance: 0 },
				{ repo: REPOSTER, rkey: 'exact-undated', distance: 0 },
				{ created_at: FIRST, repo: ARTIST, rkey: 'exact-first', distance: 0 },
				{ created_at: FIRST, repo: ARTIST, rkey: 'strong', distance: 1 }
			),
			NOW
		);
		expect(matches?.map((x) => x.rkey)).toEqual([
			'exact-first',
			'exact-later',
			'exact-undated',
			'strong',
			'loose',
			'unknown'
		]);
	});

	it('keeps the closest copy of a post that comes back twice, whichever came first', () => {
		for (const distances of [[3, 0], [0, 3], [undefined, 0], [0, undefined]]) {
			const matches = normalizeSkyseekMatches(
				answer(...distances.map((distance) => hit({ rkey: 'same', distance }))),
				NOW
			);
			expect(matches).toHaveLength(1);
			expect(matches?.[0].distance).toBe(0);
		}
	});

	it('keeps the date only the farther copy carried', () => {
		const matches = normalizeSkyseekMatches(
			answer(
				{ repo: ARTIST, rkey: 'same', distance: 0 },
				{ created_at: FIRST, repo: ARTIST, rkey: 'same', distance: 2 }
			),
			NOW
		);
		expect(matches).toEqual([
			expect.objectContaining({ distance: 0, postedAt: '2026-10-03T02:15:28.000Z' })
		]);
	});

	// A copy past the cap is dropped before the fold, so it cannot stand in for
	// the copy that is a real lead.
	it('does not let a copy past the cap replace one inside it', () => {
		const matches = normalizeSkyseekMatches(
			answer(hit({ rkey: 'same', distance: 99 }), hit({ rkey: 'same', distance: 5 })),
			NOW
		);
		expect(matches?.map((x) => x.distance)).toEqual([5]);
	});
});

describe('lookupUserAgent', () => {
	it('names the software, the project page, and the site asking', () => {
		expect(lookupUserAgent('gallery.example')).toBe('Sona/1.0 (+https://sona.fast; gallery.example)');
		expect(lookupUserAgent('  Gallery.EXAMPLE ')).toBe(
			'Sona/1.0 (+https://sona.fast; gallery.example)'
		);
		expect(lookupUserAgent('xn--bcher-kva.example')).toContain('; xn--bcher-kva.example)');
	});

	it.each([
		['nothing', undefined],
		['null', null],
		['an empty string', ''],
		['a line break', 'gallery.example\r\nX-Injected: 1'],
		['a bare line feed', 'gallery.example\nx'],
		['a closing parenthesis', 'gallery.example) Evil/9.9 (x'],
		['a space', 'gallery.example other'],
		['a semicolon', 'gallery.example; admin@gallery.example'],
		['an address', 'someone@gallery.example'],
		['a port', 'gallery.example:8788'],
		['a bracketed IPv6 literal', '[::1]'],
		['a path', 'gallery.example/admin'],
		['a non-ASCII name', 'gällery.example'],
		['a leading hyphen', '-gallery.example'],
		['a name past the DNS limit', `${'a'.repeat(63)}.`.repeat(4) + 'example']
	])('leaves the site out when the hostname is %s', (_name, hostname) => {
		expect(lookupUserAgent(hostname)).toBe('Sona/1.0 (+https://sona.fast)');
	});

	it('never yields a value fetch would refuse or split into two headers', () => {
		for (const hostname of ['gallery.example', 'a\r\nb', 'x) y (z', '']) {
			const value = lookupUserAgent(hostname);
			expect(value).toMatch(/^[\x20-\x7e]+$/);
			expect(() => new Headers({ 'user-agent': value })).not.toThrow();
		}
	});
});

describe('the two requests identify the site asking', () => {
	const UA = lookupUserAgent('gallery.example');

	it('sends the given User-Agent to Skyseek', async () => {
		const { fn, calls } = fakeFetch(jsonResponse(answer()));
		await searchSkyseek(new Blob(['x']), fn, UA);
		expect((calls[0].init.headers as Record<string, string>)['user-agent']).toBe(UA);
	});

	it('sends the given User-Agent to the AppView', async () => {
		const { fn, calls } = fakeFetch(jsonResponse({ profiles: [] }));
		await resolveBlueskyHandles([ARTIST], fn, UA);
		expect((calls[0].init.headers as Record<string, string>)['user-agent']).toBe(UA);
	});
});

describe('SKYSEEK_TIMEOUT_MS', () => {
	// Searches have measured 0.7 to 5.9 seconds. The bound has to clear the slow
	// one, and must not hold a lookup open for a service that has stopped.
	it('clears the slowest search seen and stays under a quarter of a minute', () => {
		expect(SKYSEEK_TIMEOUT_MS).toBeGreaterThan(5900);
		expect(SKYSEEK_TIMEOUT_MS).toBeLessThan(15_000);
	});
});
