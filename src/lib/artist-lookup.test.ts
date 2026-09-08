import { describe, it, expect } from 'vitest';
import {
	LOOKUP_MAX_BYTES,
	bandLabel,
	candidateArtists,
	isCrossSiteAmbiguity,
	matchHandle,
	matchHandles,
	lookupSentFile,
	nameMatchArtists,
	pickPrefillMatch,
	postDateToInput,
	prefillFields,
	profileUrlFor,
	ratingTag,
	resolveOutcome,
	siteLabel,
	stateFromResponse,
	statusLineKind,
	strictestRating,
	runLookup,
	type LookupMatch,
	type LookupResponse,
	type LookupSite
} from './artist-lookup';
// A node test may reach into the server module; the browser bundle may not.
// Importing both here is how the wire shape and the shared rules stay in step.
import {
	FUZZYSEARCH_MAX_BYTES,
	handleProfileUrl,
	pickPrefillMatch as serverPickPrefillMatch,
	strictestRating as serverStrictestRating
} from './server/fuzzysearch';
import * as m from './paraglide/messages';

function match(over: Partial<LookupMatch> = {}): LookupMatch {
	return {
		site: 'FurAffinity',
		siteId: '12345',
		handles: ['kuttoya'],
		distance: 0,
		band: 'exact',
		postedAt: '2026-03-04T10:00:00Z',
		rating: 'general',
		postUrl: 'https://www.furaffinity.net/view/12345/',
		...over
	};
}

function response(over: Partial<LookupResponse> = {}): LookupResponse {
	return {
		enabled: true,
		matches: [match()],
		localArtists: [],
		nameMatches: [],
		sourceClash: null,
		...over
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('artist-lookup — the wire shape agrees with the server', () => {
	it('uses the same size cap the endpoint enforces', () => {
		expect(LOOKUP_MAX_BYTES).toBe(FUZZYSEARCH_MAX_BYTES);
	});

	// The rules below used to exist twice, once per module, and the tests could
	// only assert the two copies agreed today. The server re-exports these now,
	// so identity is the assertion: a re-introduced copy fails here rather than
	// drifting quietly (SONA-156 round 1).
	it('is the one implementation the server module re-exports', () => {
		expect(serverStrictestRating).toBe(strictestRating);
		expect(serverPickPrefillMatch).toBe(pickPrefillMatch);
		expect(handleProfileUrl).toBe(profileUrlFor);
	});

	it('picks the strictest rating across the confident matches only', () => {
		const matches = [
			match({ rating: 'general' }),
			match({ site: 'Twitter', siteId: '9', rating: 'adult', distance: 2, band: 'strong' }),
			// Possible matches never raise the rating.
			match({ site: 'e621', siteId: '7', rating: 'adult', distance: 5, band: 'possible' })
		];
		expect(strictestRating(matches)).toEqual({ rating: 'adult', sites: ['Twitter'] });
	});

	it('prefills from the closest confident match, and from nothing looser', () => {
		const matches = [
			match({ distance: 4, band: 'possible' }),
			match({ site: 'Twitter', siteId: '9', distance: 1, band: 'strong' })
		];
		expect(pickPrefillMatch(matches)?.site).toBe('Twitter');
		expect(pickPrefillMatch([match({ distance: 6, band: 'possible' })])).toBeNull();
	});
});

describe('resolveOutcome', () => {
	it('is "none" when nothing matched confidently', () => {
		expect(resolveOutcome(response({ matches: [] }))).toBe('none');
		expect(resolveOutcome(response({ matches: [match({ distance: 5, band: 'possible' })] }))).toBe(
			'none'
		);
	});

	it('is "existing" for exactly one local artist', () => {
		const data = response({ localArtists: [{ matchIndex: 0, artists: [{ id: 3, name: 'Kuttoya' }] }] });
		expect(resolveOutcome(data)).toBe('existing');
		expect(candidateArtists(data)).toEqual([{ id: 3, name: 'Kuttoya', site: 'FurAffinity' }]);
		expect(isCrossSiteAmbiguity(data)).toBe(false);
	});

	it('is "ambiguous" for two, and names the cross-site case', () => {
		const sameSite = response({
			localArtists: [
				{
					matchIndex: 0,
					artists: [
						{ id: 3, name: 'Kuttoya' },
						{ id: 4, name: 'Kuttoya Art' }
					]
				}
			]
		});
		expect(resolveOutcome(sameSite)).toBe('ambiguous');
		expect(isCrossSiteAmbiguity(sameSite)).toBe(false);

		const crossSite = response({
			matches: [match(), match({ site: 'Twitter', siteId: '9', distance: 1, band: 'strong' })],
			localArtists: [
				{ matchIndex: 0, artists: [{ id: 3, name: 'Kuttoya' }] },
				{ matchIndex: 1, artists: [{ id: 4, name: 'Someone Else' }] }
			]
		});
		expect(resolveOutcome(crossSite)).toBe('ambiguous');
		expect(isCrossSiteAmbiguity(crossSite)).toBe(true);
		expect(candidateArtists(crossSite).map((c) => c.site)).toEqual(['FurAffinity', 'Twitter']);
	});

	it('is "new" for an unmatched handle on a site with an artist column', () => {
		expect(resolveOutcome(response())).toBe('new');
		expect(
			resolveOutcome(response({ matches: [match({ site: 'Twitter', siteId: '9' })] }))
		).toBe('new');
	});

	it('is "unlinked" on Weasyl and e621, which have no artist column yet', () => {
		for (const site of ['Weasyl', 'e621'] as LookupSite[]) {
			expect(resolveOutcome(response({ matches: [match({ site, siteId: '5' })] }))).toBe('unlinked');
		}
	});

	it('ignores a local artist that only a possible match named', () => {
		const data = response({
			matches: [match(), match({ site: 'e621', siteId: '7', distance: 6, band: 'possible' })],
			localArtists: [{ matchIndex: 1, artists: [{ id: 9, name: 'Loose' }] }]
		});
		expect(candidateArtists(data)).toEqual([]);
		expect(resolveOutcome(data)).toBe('new');
	});

	it('reads name matches off the prefill match only', () => {
		const data = response({
			nameMatches: [{ matchIndex: 0, artists: [{ id: 8, name: 'kuttoya' }] }]
		});
		expect(nameMatchArtists(data)).toEqual([{ id: 8, name: 'kuttoya' }]);
		expect(nameMatchArtists(response({ nameMatches: [{ matchIndex: 3, artists: [] }] }))).toEqual([]);
	});
});

describe('labels and formatting', () => {
	it('labels each band, and says nothing about an unknown distance', () => {
		expect(bandLabel('exact')).toBe('Exact match');
		expect(bandLabel('strong')).toBe('Strong match');
		expect(bandLabel('possible')).toBe('Possible match');
		expect(bandLabel(null)).toBeNull();
	});

	it('spells sites as their own names', () => {
		expect(siteLabel('e621')).toBe('e621');
		expect(siteLabel('FurAffinity')).toBe('FurAffinity');
	});

	it('builds the rating tag, with the parent spelling for the shared box', () => {
		const strictest = { rating: 'mature' as const, sites: ['FurAffinity', 'Twitter'] as LookupSite[] };
		expect(ratingTag(strictest)).toBe('Rated Mature on FurAffinity, Twitter');
		expect(ratingTag(strictest, { parent: true })).toBe(
			'Rated Mature on FurAffinity, Twitter · parent'
		);
		expect(ratingTag(null)).toBeNull();
		expect(ratingTag({ rating: 'adult', sites: [] })).toBeNull();
	});

	it('reduces a post timestamp to the calendar day the date input wants', () => {
		expect(postDateToInput('2026-03-04T10:00:00Z')).toBe('2026-03-04');
		expect(postDateToInput('2026-03-04')).toBe('2026-03-04');
		expect(postDateToInput(null)).toBeNull();
		expect(postDateToInput('')).toBeNull();
		expect(postDateToInput('some time last spring')).toBeNull();
		expect(postDateToInput('2026-13-45T00:00:00Z')).toBeNull();
	});

	it('strips the @ from handles and joins the rest', () => {
		expect(matchHandle(match({ handles: ['@kuttoya'] }))).toBe('kuttoya');
		expect(matchHandle(match({ handles: [] }))).toBe('');
		expect(matchHandle(null)).toBe('');
		expect(matchHandles(match({ handles: ['@a', ' b ', '  '] }))).toBe('a, b');
	});

	it('has the plural keys the panel needs', () => {
		expect(m.admin_lookup_found_on_sites({ count: 1 })).toBe('Found on 1 site');
		expect(m.admin_lookup_found_on_sites({ count: 2 })).toBe('Found on 2 sites');
		expect(m.admin_lookup_variants({ count: 1 })).toBe(' and its 1 variant');
		expect(m.admin_lookup_variants({ count: 3 })).toBe(' and its 3 variants');
		expect(m.admin_lookup_pieces({ count: 1 })).toBe('1 piece');
		expect(m.admin_lookup_pieces({ count: 12 })).toBe('12 pieces');
	});

	// resolveOutcome fires at two OR MORE candidates, so the sentence counts
	// rather than saying "two" (SONA-156 round 1, copy gate).
	it('counts the ambiguous candidates instead of claiming there are two', () => {
		expect(m.admin_lookup_ambiguous({ handle: 'kuttoya', count: 3 })).toBe(
			'kuttoya matches 3 artists in your list.'
		);
		expect(m.admin_lookup_ambiguous_cross({ count: 2 })).toBe(
			'These matches point to 2 artists in your list.'
		);
	});

	// The eyebrow puts this straight after "FOUND ON 2 SITES"; without the
	// leading space in the message the compiler leaves them jammed together.
	it('carries its own leading space in the filename eyebrow', () => {
		expect(m.admin_lookup_eyebrow_file({ fileName: 'photo.png' })).toBe(' \u00b7 photo.png');
	});

	// The status line for a date-only prefill must not claim a reason it cannot
	// know: the URL is also left alone when the operator already typed one.
	it('says only what the date-only prefill did', () => {
		expect(m.admin_lookup_status_date_only({ site: 'FurAffinity' })).toBe(
			'Sona filled the commissioned date from the FurAffinity post and left the source post URL alone. You can change the date before you save.'
		);
	});
});

describe('prefillFields', () => {
	it('fills both fields when both are empty', () => {
		expect(prefillFields(match(), { sourcePostUrl: true, commissionedAt: true })).toEqual({
			sourcePostUrl: 'https://www.furaffinity.net/view/12345/',
			commissionedAt: '2026-03-04'
		});
	});

	it('never overwrites a field the operator already filled', () => {
		expect(prefillFields(match(), { sourcePostUrl: false, commissionedAt: false })).toEqual({});
		expect(prefillFields(match(), { sourcePostUrl: false, commissionedAt: true })).toEqual({
			commissionedAt: '2026-03-04'
		});
	});

	it('leaves the URL alone in the clash case, and fills the date', () => {
		expect(
			prefillFields(
				match(),
				{ sourcePostUrl: true, commissionedAt: true },
				{ skipSourceUrl: true }
			)
		).toEqual({ commissionedAt: '2026-03-04' });
	});

	it('skips a date the post does not carry', () => {
		expect(
			prefillFields(match({ postedAt: null }), { sourcePostUrl: true, commissionedAt: true })
		).toEqual({ sourcePostUrl: 'https://www.furaffinity.net/view/12345/' });
	});

	it('fills nothing without a confident match', () => {
		expect(prefillFields(null, { sourcePostUrl: true, commissionedAt: true })).toEqual({});
	});
});

describe('statusLineKind', () => {
	it('names only the fields that were actually filled', () => {
		expect(statusLineKind({ sourcePostUrl: 'u', commissionedAt: 'd' })).toBe('both');
		expect(statusLineKind({ sourcePostUrl: 'u' })).toBe('url_only');
		expect(statusLineKind({ commissionedAt: 'd' })).toBe('date_only');
		expect(statusLineKind({})).toBe('none');
	});

	it('says the clash sentence only when the date was filled', () => {
		expect(statusLineKind({ commissionedAt: 'd' }, { clash: true })).toBe('clash');
		expect(statusLineKind({}, { clash: true })).toBe('none');
	});
});

describe('stateFromResponse', () => {
	it('reads matches into the results state', async () => {
		const state = await stateFromResponse(jsonResponse(response()));
		expect(state).toMatchObject({ kind: 'results', applied: false });
		if (state.kind !== 'results') throw new Error('expected results');
		expect(state.data.matches).toHaveLength(1);
		expect(state.data.sourceClash).toBeNull();
	});

	// The endpoint builds every post URL, so anything that is not an https link
	// came from something that is not the endpoint — and both the panel row and
	// the upload tile render it as an anchor the operator clicks.
	it('drops a match whose post URL is not an https link', async () => {
		const state = await stateFromResponse(
			jsonResponse(
				response({
					matches: [
						match({ postUrl: 'javascript:alert(1)' }),
						match({ site: 'Twitter', siteId: '9', postUrl: 'https://twitter.com/a/status/9' })
					]
				})
			)
		);
		if (state.kind !== 'results') throw new Error('expected results');
		expect(state.data.matches.map((x) => x.postUrl)).toEqual(['https://twitter.com/a/status/9']);
	});

	it('reads a result whose only match has an unusable URL as no_match', async () => {
		expect(
			await stateFromResponse(
				jsonResponse(response({ matches: [match({ postUrl: 'javascript:alert(1)' })] }))
			)
		).toEqual({ kind: 'no_match' });
	});

	it('reads an empty match list as no_match', async () => {
		expect(await stateFromResponse(jsonResponse({ enabled: true, matches: [] }))).toEqual({
			kind: 'no_match'
		});
	});

	it('maps each failure by the body error, not by the status', async () => {
		const cases = [
			['key_refused', 424],
			['rate_limited', 429],
			['too_large', 413],
			['invalid_image', 422],
			['unavailable', 502]
		] as const;
		for (const [error, status] of cases) {
			expect(await stateFromResponse(jsonResponse({ enabled: true, error }, status))).toEqual({
				kind: 'failed',
				reason: error
			});
		}
	});

	it('treats an expired admin session as "sign in again", never as a refused key', async () => {
		// The admin gate answers with plain text, so this must not be parsed.
		const gate = new Response('Unauthorized', {
			status: 401,
			headers: { 'content-type': 'text/plain' }
		});
		expect(await stateFromResponse(gate)).toEqual({ kind: 'failed', reason: 'signed_out' });
	});

	it('falls back to unavailable for a body it cannot read', async () => {
		const html = new Response('<html>proxy</html>', {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});
		expect(await stateFromResponse(html)).toEqual({ kind: 'failed', reason: 'unavailable' });

		const broken = new Response('{', { status: 200, headers: { 'content-type': 'application/json' } });
		expect(await stateFromResponse(broken)).toEqual({ kind: 'failed', reason: 'unavailable' });

		const unknownError = jsonResponse({ enabled: true, error: 'something new' }, 500);
		expect(await stateFromResponse(unknownError)).toEqual({ kind: 'failed', reason: 'unavailable' });
	});

	it('treats a key that went away mid-session as an outage, not as a result', async () => {
		expect(await stateFromResponse(jsonResponse({ enabled: false }))).toEqual({
			kind: 'failed',
			reason: 'unavailable'
		});
	});
});

describe('lookupSentFile', () => {
	// The disclosure is about the FILE having left the browser, not about the
	// lookup having worked: it belongs on a failure just as much as on a result.
	it('is true for every outcome the request actually reached', () => {
		expect(lookupSentFile({ kind: 'results', applied: false, data: response() })).toBe(true);
		expect(lookupSentFile({ kind: 'no_match' })).toBe(true);
		for (const reason of ['key_refused', 'rate_limited', 'invalid_image', 'unavailable', 'signed_out'] as const) {
			expect(lookupSentFile({ kind: 'failed', reason })).toBe(true);
		}
	});

	// too_large is refused by runLookup before anything is sent, so claiming the
	// file went out would be a false disclosure.
	it('is false for too_large, which never leaves the browser', () => {
		expect(lookupSentFile({ kind: 'failed', reason: 'too_large' })).toBe(false);
	});

	it('says nothing before an outcome exists', () => {
		expect(lookupSentFile({ kind: 'idle' })).toBe(false);
		expect(lookupSentFile({ kind: 'searching' })).toBe(false);
	});
});

describe('runLookup', () => {
	it('refuses an oversized file before sending anything', async () => {
		let called = false;
		const file = new File(['x'], 'big.png', { type: 'image/png' });
		Object.defineProperty(file, 'size', { value: LOOKUP_MAX_BYTES + 1 });
		const state = await runLookup(
			{ file },
			{
				fetchFn: (async () => {
					called = true;
					return jsonResponse(response());
				}) as unknown as typeof fetch
			}
		);
		expect(state).toEqual({ kind: 'failed', reason: 'too_large' });
		expect(called).toBe(false);
	});

	it('posts a file as multipart', async () => {
		let body: unknown;
		await runLookup(
			{ file: new File(['x'], 'a.png', { type: 'image/png' }) },
			{
				fetchFn: (async (_url: string, init: RequestInit) => {
					body = init.body;
					return jsonResponse(response());
				}) as unknown as typeof fetch
			}
		);
		expect(body).toBeInstanceOf(FormData);
		expect((body as FormData).get('file')).toBeInstanceOf(File);
	});

	it('posts a stored image by id, never by URL', async () => {
		let seen: { url?: string; body?: unknown } = {};
		await runLookup(
			{ imageId: 7 },
			{
				fetchFn: (async (url: string, init: RequestInit) => {
					seen = { url, body: init.body };
					return jsonResponse(response());
				}) as unknown as typeof fetch
			}
		);
		expect(seen.url).toBe('/api/admin/artist-lookup');
		expect(JSON.parse(String(seen.body))).toEqual({ imageId: 7 });
	});

	it('reads a rejected request as unavailable', async () => {
		const state = await runLookup(
			{ imageId: 1 },
			{ fetchFn: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch }
		);
		expect(state).toEqual({ kind: 'failed', reason: 'unavailable' });
	});
});
