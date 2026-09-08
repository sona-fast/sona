import { describe, it, expect } from 'vitest';
import {
	LOOKUP_MAX_BYTES,
	bandLabel,
	candidateArtists,
	isCrossSiteAmbiguity,
	matchHandle,
	matchHandles,
	matchedSites,
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
// Importing both here is how the two copies of the wire shape stay in step.
import {
	FUZZYSEARCH_MAX_BYTES,
	handleProfileUrl,
	strictestRating as serverStrictestRating,
	type LookupMatch as ServerLookupMatch
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

	it('builds the same profile URLs the endpoint matches artists on', () => {
		const sites: LookupSite[] = ['FurAffinity', 'Twitter', 'Weasyl', 'e621'];
		for (const site of sites) {
			expect(profileUrlFor(site, '@kuttoya')).toBe(handleProfileUrl(site, '@kuttoya'));
		}
		expect(profileUrlFor('FurAffinity', '  @ ')).toBeNull();
		// A slash in a handle must not re-point the URL at another page.
		expect(profileUrlFor('Twitter', 'a/b')).toBe('https://twitter.com/a%2Fb');
	});

	it('picks the same strictest rating the server does', () => {
		const matches = [
			match({ rating: 'general' }),
			match({ site: 'Twitter', siteId: '9', rating: 'adult', distance: 2, band: 'strong' }),
			// Possible matches never raise the rating.
			match({ site: 'e621', siteId: '7', rating: 'adult', distance: 5, band: 'possible' })
		];
		expect(strictestRating(matches)).toEqual(
			serverStrictestRating(matches as unknown as ServerLookupMatch[])
		);
		expect(strictestRating(matches)).toEqual({ rating: 'adult', sites: ['Twitter'] });
	});

	it('picks the same prefill match the server does', () => {
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

	it('lists the sites a result touched, once each, in order', () => {
		expect(
			matchedSites([match(), match({ siteId: '2' }), match({ site: 'Twitter', siteId: '9' })])
		).toEqual(['FurAffinity', 'Twitter']);
	});

	it('has the plural keys the panel needs', () => {
		expect(m.admin_lookup_found_on_sites({ count: 1 })).toBe('Found on 1 site');
		expect(m.admin_lookup_found_on_sites({ count: 2 })).toBe('Found on 2 sites');
		expect(m.admin_lookup_variants({ count: 1 })).toBe(' and its 1 variant');
		expect(m.admin_lookup_variants({ count: 3 })).toBe(' and its 3 variants');
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
