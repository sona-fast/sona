import { describe, it, expect } from 'vitest';
import {
	LOOKUP_MAX_BYTES,
	bandLabel,
	candidateArtists,
	isCrossSiteAmbiguity,
	matchForArtist,
	matchHandle,
	matchHandles,
	matchKey,
	lookupSentFile,
	mergeSamePost,
	nameMatchArtists,
	newArtistSeed,
	seedStatusKind,
	pickPrefillMatch,
	postDateToInput,
	prefillFields,
	prefillForResult,
	profileUrlFor,
	ratingTag,
	resolveOutcome,
	siteLabel,
	stateFromResponse,
	statusLineKind,
	strictestRating,
	tileResultText,
	runLookup,
	sentAfterApplyThrew,
	withCreatedArtist,
	type LookupFailReason,
	type LookupMatch,
	type LookupRating,
	type LookupResponse,
	type LookupSite,
	type LookupState
} from './artist-lookup';
// A node test may reach into the server module; the browser bundle may not.
// Importing both here is how the wire shape and the shared rules stay in step.
import {
	FUZZYSEARCH_MAX_BYTES,
	handleProfileUrl,
	mergeSamePost as serverMergeSamePost,
	pickPrefillMatch as serverPickPrefillMatch,
	strictestRating as serverStrictestRating,
	type LookupFailure as ServerLookupFailure,
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

	// The rules below used to exist twice, once per module, and the tests could
	// only assert the two copies agreed today. The server re-exports these now,
	// so identity is the assertion: a re-introduced copy fails here rather than
	// drifting quietly (SONA-156 round 1).
	it('is the one implementation the server module re-exports', () => {
		expect(serverStrictestRating).toBe(strictestRating);
		expect(serverMergeSamePost).toBe(mergeSamePost);
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

	// One post identity, built three ways: the server's dedupe, the client's, and
	// the panel's keyed each. A bare concatenation is not an identity — a site
	// "e621" with id "12" reads the same as a site "e6211" with id "2" — so the
	// helper separates the parts with a character neither of them can hold.
	it('keys a post on its site and id with no pair able to collide', () => {
		expect(matchKey(match({ site: 'FurAffinity', siteId: '12345' }))).toBe(
			matchKey({ site: 'FurAffinity', siteId: '12345' })
		);
		expect(matchKey({ site: 'e621', siteId: '12' })).not.toBe(
			matchKey({ site: 'e6211' as LookupSite, siteId: '2' })
		);
		expect('e621' + '12').toBe('e6211' + '2');
		// Both parts are still in the key, and the separator is not something a
		// site name or a site id can contain.
		expect(matchKey({ site: 'e621', siteId: '12' })).toContain('e621');
		expect(matchKey({ site: 'e621', siteId: '12' })).toContain('12');
		expect(matchKey({ site: 'e621', siteId: '12' })).toBe('e621\u000012');
	});

	// Two comparators read the rating order: strictestRating across a match list,
	// and the one inside mergeSamePost that folds a duplicate post. They held a
	// copy of the order each, so a new rating added to one and not the other
	// would have made them disagree about which of a pair is stricter.
	it('ranks every pair of ratings the same way in both comparators', () => {
		const ratings: (LookupRating | null)[] = [null, 'general', 'mature', 'adult'];
		for (const a of ratings) {
			for (const b of ratings) {
				const merged = mergeSamePost(
					match({ rating: a }),
					match({ site: 'Twitter', siteId: '9', rating: b })
				).rating;
				const across = strictestRating([
					match({ rating: a }),
					match({ site: 'Twitter', siteId: '9', rating: b })
				]);
				expect(merged).toBe(across?.rating ?? null);
			}
		}
	});

	// No cast: a renamed or retyped field on either side fails `npm run check`,
	// which is the only place a restated wire shape can be caught drifting.
	it('states the same match shape the server does, in both directions', () => {
		const fromClient: ServerLookupMatch = match();
		const fromServer: LookupMatch = fromClient;
		expect(fromServer.site).toBe('FurAffinity');
	});

	// A server reason the client has no case for degrades to 'unavailable' and
	// shows the generic failure copy. The Record's key type is the server union,
	// so adding a reason there fails the type check until this map names it.
	it('maps every failure the server can report to its own reason', async () => {
		const reasons: Record<ServerLookupFailure, LookupFailReason> = {
			key_refused: 'key_refused',
			rate_limited: 'rate_limited',
			too_large: 'too_large',
			invalid_image: 'invalid_image',
			unavailable: 'unavailable'
		};
		for (const [wire, expected] of Object.entries(reasons)) {
			const state = await stateFromResponse(jsonResponse({ enabled: true, error: wire }, 424));
			expect(state).toEqual({ kind: 'failed', reason: expected, sent: true });
		}
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

describe('withCreatedArtist', () => {
	// Left at 'new', the panel keeps offering "Add {handle} as a new artist" for
	// an artist that now exists, and POST /api/artists enforces no name
	// uniqueness on a non-registry create — so the second click makes a duplicate
	// the operator then merges by hand (SONA-156 round 11).
	it('turns the outcome from new into existing, with the artist selected', () => {
		const before = response();
		expect(resolveOutcome(before)).toBe('new');

		const after = withCreatedArtist(before, { id: 7, name: 'Kuttoya' });

		expect(resolveOutcome(after)).toBe('existing');
		expect(candidateArtists(after)).toEqual([
			{ id: 7, name: 'Kuttoya', pieces: 0, site: 'FurAffinity' }
		]);
		// The record it came from is untouched.
		expect(before.localArtists).toEqual([]);
	});

	// The hit has to land on a CONFIDENT match, or candidateArtists skips it and
	// the outcome never moves.
	it('records the hit against the prefill match', () => {
		const data = withCreatedArtist(
			response({ matches: [match({ band: 'possible', distance: 9 }), match({ siteId: '9' })] }),
			{ id: 7, name: 'Kuttoya' }
		);
		expect(data.localArtists).toEqual([
			{ matchIndex: 1, artists: [{ id: 7, name: 'Kuttoya', pieces: 0 }] }
		]);
	});

	it('adds nothing twice, and nothing at all with no confident match', () => {
		const once = withCreatedArtist(response(), { id: 7, name: 'Kuttoya' });
		expect(withCreatedArtist(once, { id: 7, name: 'Kuttoya' })).toBe(once);
		const weak = response({ matches: [match({ band: 'possible', distance: 9 })] });
		expect(withCreatedArtist(weak, { id: 7, name: 'Kuttoya' })).toBe(weak);
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

	// A duplicate source URL says which piece already claims the post, and
	// nothing about which of two same-named artists drew it — so the clash panel
	// gets the same picker, and neither candidate is chosen for the operator.
	it('stays "ambiguous" under a source clash', () => {
		const data = response({
			localArtists: [
				{
					matchIndex: 0,
					artists: [
						{ id: 3, name: 'Kuttoya' },
						{ id: 4, name: 'Kuttoya Art' }
					]
				}
			],
			sourceClash: {
				imageId: 4,
				title: 'Beach',
				isVariant: false,
				parentImageId: null,
				variantCount: 0,
				thumbnailUrl: null,
				artistName: null,
				uploadedAt: null,
				width: null,
				height: null
			}
		});
		expect(resolveOutcome(data)).toBe('ambiguous');
		expect(candidateArtists(data)).toHaveLength(2);
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

	// "Add {handle} as a new artist" with an empty handle reads as "Add  as a
	// new artist", and the sentence above it promises a poster the match never
	// named. Nothing to add, so nothing is offered.
	it('is "none" when the prefill match names no handle', () => {
		expect(resolveOutcome(response({ matches: [match({ handles: [] })] }))).toBe('none');
		expect(resolveOutcome(response({ matches: [match({ handles: ['  @  '] })] }))).toBe('none');
		for (const site of ['Weasyl', 'e621'] as LookupSite[]) {
			expect(resolveOutcome(response({ matches: [match({ site, siteId: '5', handles: [] })] }))).toBe(
				'none'
			);
		}
	});

	// The candidates are unioned across every confident match, so a handle-less
	// match sorting first must not take away an offer another one earned.
	it('still offers the local artist a later match named', () => {
		const data = response({
			matches: [match({ handles: [] }), match({ site: 'Twitter', siteId: '9', distance: 1, band: 'strong' })],
			localArtists: [{ matchIndex: 1, artists: [{ id: 3, name: 'Kuttoya' }] }]
		});
		expect(resolveOutcome(data)).toBe('existing');
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

	it('refuses a day the calendar does not have rather than rolling it over', () => {
		expect(postDateToInput('2026-02-30')).toBeNull();
		expect(postDateToInput('2026-02-30T10:00:00Z')).toBeNull();
		expect(postDateToInput('2026-04-31')).toBeNull();
		expect(postDateToInput('2024-02-29')).toBe('2024-02-29');
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
			'Sona filled the commissioned date from the FurAffinity post and left the source post URL as it was. You can change the date before you save.'
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

// The one decision both pages were making by hand: which match to fill from,
// which fields count as empty, and the clash skip.
describe('prefillForResult', () => {
	it('fills what the form left empty, reading emptiness from the values', () => {
		expect(prefillForResult(response(), { sourcePostUrl: '', commissionedAt: '  ' })).toEqual({
			sourcePostUrl: 'https://www.furaffinity.net/view/12345/',
			commissionedAt: '2026-03-04'
		});
	});

	it('keeps what the operator typed', () => {
		expect(
			prefillForResult(response(), {
				sourcePostUrl: 'https://example.test/mine',
				commissionedAt: '2026-01-01'
			})
		).toEqual({});
	});

	it('leaves the URL to the piece that already claims it', () => {
		const clash = response({
			sourceClash: {
				imageId: 4,
				title: 'Beach',
				isVariant: false,
				parentImageId: null,
				variantCount: 0,
				thumbnailUrl: null,
				artistName: null,
				uploadedAt: null,
				width: null,
				height: null
			}
		});
		expect(prefillForResult(clash, { sourcePostUrl: '', commissionedAt: '' })).toEqual({
			commissionedAt: '2026-03-04'
		});
	});
});

// The visible line and the spoken one are built from the same parts, so a match
// with no band cannot render a dangling separator or read one out.
describe('tileResultText', () => {
	it('separates the band with a middle dot for the eye and a comma for speech', () => {
		const text = tileResultText('kuttoya', 'FurAffinity', 'exact');
		expect(text.line).toBe(`kuttoya on FurAffinity · ${m.admin_lookup_band_exact()}`);
		expect(text.spoken).toBe(`kuttoya on FurAffinity, ${m.admin_lookup_band_exact()}`);
	});

	it('drops the separator entirely when the match carries no band', () => {
		const text = tileResultText('kuttoya', 'FurAffinity', null);
		expect(text.line).toBe('kuttoya on FurAffinity');
		expect(text.spoken).toBe('kuttoya on FurAffinity');
		expect(text.line).not.toContain('·');
	});

	// A Twitter post can come back with no handle at all. "{handle} on {site}"
	// promises a poster, so the empty case says "unknown poster" rather than
	// putting anything else where the name goes.
	it('names an unknown poster when the match carries no handle', () => {
		const text = tileResultText('', 'Twitter', null);
		expect(text.line).toBe(m.admin_lookup_match_unknown({ site: 'Twitter' }));
		expect(text.spoken).toBe(text.line);
		const banded = tileResultText('   ', 'Twitter', 'exact');
		expect(banded.line).toBe(
			`${m.admin_lookup_match_unknown({ site: 'Twitter' })} · ${m.admin_lookup_band_exact()}`
		);
	});
});

// The edit page's inline new-artist form is subject to the same rule as the
// two fields above: the operator can switch to "new", type a display name and
// paste a profile URL, and only then ask for a lookup (SONA-156 round 1).
describe('newArtistSeed', () => {
	const empty = { artistName: true, profileUrl: true };

	it('fills both fields when both are empty', () => {
		expect(newArtistSeed('kuttoya', 'FurAffinity', true, empty)).toEqual({
			artistName: 'kuttoya',
			profileUrl: 'https://www.furaffinity.net/user/kuttoya/'
		});
		expect(newArtistSeed('@kuttoya', 'Twitter', true, empty)).toEqual({
			artistName: 'kuttoya',
			profileUrl: 'https://twitter.com/kuttoya'
		});
	});

	it('never overwrites a name or a URL the operator already typed', () => {
		expect(
			newArtistSeed('kuttoya', 'FurAffinity', true, { artistName: false, profileUrl: false })
		).toEqual({});
		expect(
			newArtistSeed('kuttoya', 'FurAffinity', true, { artistName: false, profileUrl: true })
		).toEqual({ profileUrl: 'https://www.furaffinity.net/user/kuttoya/' });
		expect(
			newArtistSeed('kuttoya', 'FurAffinity', true, { artistName: true, profileUrl: false })
		).toEqual({ artistName: 'kuttoya' });
	});

	it('seeds a name only for a site with no artist column', () => {
		expect(newArtistSeed('kuttoya', 'Weasyl', false, empty)).toEqual({ artistName: 'kuttoya' });
	});

	it('seeds nothing without a handle', () => {
		expect(newArtistSeed('   ', 'FurAffinity', true, empty)).toEqual({});
		expect(newArtistSeed('  @  ', 'FurAffinity', true, empty)).toEqual({});
	});
});

describe('seedStatusKind', () => {
	it('names only the fields the seed actually wrote', () => {
		expect(seedStatusKind({ artistName: 'k', profileUrl: 'u' })).toBe('both');
		expect(seedStatusKind({ artistName: 'k' })).toBe('name_only');
		expect(seedStatusKind({ profileUrl: 'u' })).toBe('link_only');
		expect(seedStatusKind({})).toBe('none');
	});

	// The seed record is immutable, so a field the operator typed over is dropped
	// by the edited-since flags rather than by rewriting what the lookup did. The
	// remaining sentence claims only the other field — neither name_only nor
	// link_only says anything about the one that is gone (SONA-156 round 10).
	it('drops a seeded field the operator typed over', () => {
		const seed = { artistName: 'k', profileUrl: 'u' };
		expect(seedStatusKind(seed, { profileUrl: true })).toBe('name_only');
		expect(seedStatusKind(seed, { artistName: true })).toBe('link_only');
		expect(seedStatusKind(seed, { artistName: true, profileUrl: true })).toBe('none');
		// A field the seed never wrote cannot be edited-since; the flag is inert.
		expect(seedStatusKind({ artistName: 'k' }, { profileUrl: true })).toBe('name_only');
	});

	// Round 13 asked for an announcement when a second add-new click refills a
	// field the operator cleared, on the grounds that the merged record still
	// reads 'both' and the panel's sentence therefore does not change. It does
	// change: clearing the field drops its "From lookup" tag, which is what the
	// edited-since flag reads, so the kind falls to the other field's and the
	// refill lifts it back. The panel body is an atomic role="status", so that
	// swap is the announcement — a second one would say the same thing twice.
	it('changes when a cleared field is seeded again, so the sentence changes with it', () => {
		const seed = { artistName: 'k', profileUrl: 'u' };
		// The operator clears the name: its tag goes, so the sentence claims the link.
		expect(seedStatusKind(seed, { artistName: true })).toBe('link_only');
		// The next click writes the name back and re-tags it.
		expect(seedStatusKind(seed, {})).toBe('both');
	});
});

describe('matchForArtist', () => {
	// The candidates are unioned across every confident match, so the match that
	// named one is not always the prefill match. Pairing the prefill match's
	// handle with that candidate's name renders "alice is already in your list
	// as Bob".
	it('names the match whose hit produced the candidate, not the prefill match', () => {
		const data = response({
			matches: [
				match({ handles: ['alice'], distance: 0, band: 'exact' }),
				match({ site: 'Twitter', siteId: '9', handles: ['bobby'], distance: 2, band: 'strong' })
			],
			localArtists: [{ matchIndex: 1, artists: [{ id: 7, name: 'Bob' }] }]
		});
		expect(matchHandle(pickPrefillMatch(data.matches))).toBe('alice');
		expect(candidateArtists(data).map((a) => a.id)).toEqual([7]);
		expect(matchHandle(matchForArtist(data, 7))).toBe('bobby');
		expect(matchForArtist(data, 99)).toBeNull();
	});

	// A looser band never produces a candidate, so it never names one either.
	it('ignores a hit on a match that is not confident', () => {
		const data = response({
			matches: [match({ handles: ['alice'], distance: 8, band: 'possible' })],
			localArtists: [{ matchIndex: 0, artists: [{ id: 7, name: 'Bob' }] }]
		});
		expect(matchForArtist(data, 7)).toBeNull();
	});
});

describe('statusLineKind', () => {
	it('names only the fields that were actually filled', () => {
		expect(statusLineKind({ sourcePostUrl: 'u', commissionedAt: 'd' })).toBe('both');
		expect(statusLineKind({ sourcePostUrl: 'u' })).toBe('url_only');
		expect(statusLineKind({ commissionedAt: 'd' })).toBe('date_only');
		expect(statusLineKind({})).toBe('none');
	});

	// Dropping an edited field from the record used to reclassify it as untouched,
	// so url_only claimed Sona "left the commissioned date as it was" about a date
	// it had filled and the operator then changed. The record stays put and the
	// edited flags decide what is still attributable (SONA-156 round 10).
	it('says nothing about a filled field the operator typed over', () => {
		const both = { sourcePostUrl: 'u', commissionedAt: 'd' };
		expect(statusLineKind(both, { edited: { commissionedAt: true } })).toBe('url_kept');
		expect(statusLineKind(both, { edited: { sourcePostUrl: true } })).toBe('date_kept');
		expect(statusLineKind(both, { edited: { sourcePostUrl: true, commissionedAt: true } })).toBe(
			'none'
		);
		// A field the lookup never filled is not edited-since: the sentence may
		// still say it was left as it was.
		expect(statusLineKind({ sourcePostUrl: 'u' }, { edited: { commissionedAt: true } })).toBe(
			'url_only'
		);
		expect(statusLineKind({ commissionedAt: 'd' }, { edited: { sourcePostUrl: true } })).toBe(
			'date_only'
		);
	});

	// The kept sentences name their own field and stop; the "left alone" half is
	// exactly the claim that would be false.
	it('claims only the kept field in both locales', () => {
		expect(m.admin_lookup_status_url_kept({ site: 'FurAffinity' }, { locale: 'en' })).toBe(
			'Sona filled the source post URL from the FurAffinity post. You can change it before you save.'
		);
		expect(m.admin_lookup_status_date_kept({ site: 'FurAffinity' }, { locale: 'en' })).toBe(
			'Sona filled the commissioned date from the FurAffinity post. You can change it before you save.'
		);
		for (const locale of ['en', 'ja'] as const) {
			for (const line of [
				m.admin_lookup_status_url_kept({ site: 'FurAffinity' }, { locale }),
				m.admin_lookup_status_date_kept({ site: 'FurAffinity' }, { locale })
			]) {
				expect(line).not.toMatch(/as it was|そのまま/);
			}
		}
	});

	// The clash sentence says the URL was left EMPTY, which stays true however
	// the date is edited — but an edited date is no longer Sona's to claim.
	it('drops the clash sentence once the date it names is typed over', () => {
		expect(
			statusLineKind({ commissionedAt: 'd' }, { clash: true, edited: { commissionedAt: true } })
		).toBe('none');
	});

	it('says the clash sentence only when the date was filled', () => {
		expect(statusLineKind({ commissionedAt: 'd' }, { clash: true })).toBe('clash');
		expect(statusLineKind({}, { clash: true })).toBe('none');
	});

	// prefillForResult skips the source URL on ANY clash, whatever the field
	// holds, so "left the source post URL empty" is a false claim to an operator
	// who pasted one first or to an edit-page image that already has one.
	it('does not call the source URL empty when the field holds one', () => {
		const filled = { commissionedAt: 'd' };
		expect(statusLineKind(filled, { clash: true, urlHeld: true })).toBe('clash_kept');
		expect(statusLineKind(filled, { clash: true, urlHeld: false })).toBe('clash');
		// An edited date is still nobody's to claim, held URL or not.
		expect(
			statusLineKind(filled, { clash: true, urlHeld: true, edited: { commissionedAt: true } })
		).toBe('none');
		// And urlHeld says nothing outside a clash, where the URL is fillable.
		expect(statusLineKind({ sourcePostUrl: 'u' }, { urlHeld: true })).toBe('url_only');
	});

	it('claims the date and never the URL in the clash_kept sentence', () => {
		expect(
			m.admin_lookup_status_clash_kept({ site: 'FurAffinity', title: 'Ref' }, { locale: 'en' })
		).toBe(
			'Sona filled the commissioned date from the FurAffinity post and left your source post URL as it was, because that post is already the source of Ref. You can change the date before you save.'
		);
		for (const locale of ['en', 'ja'] as const) {
			const line = m.admin_lookup_status_clash_kept(
				{ site: 'FurAffinity', title: 'Ref' },
				{ locale }
			);
			expect(line).not.toMatch(/empty|空/);
		}
	});

	// The clash pair says the FOUND post is the source of the other piece. "{title}
	// already uses it" made "it" the URL the sentence had just named — the
	// operator's own pasted one in the kept case — which is the false claim the
	// pair exists to avoid.
	it('names the found post, not the operator URL, as what clashes', () => {
		expect(
			m.admin_lookup_status_clash({ site: 'FurAffinity', title: 'Ref' }, { locale: 'en' })
		).toBe(
			'Sona filled the commissioned date from the FurAffinity post and left the source post URL empty, because that post is already the source of Ref. You can change the date before you save.'
		);
		for (const key of [m.admin_lookup_status_clash, m.admin_lookup_status_clash_kept]) {
			for (const locale of ['en', 'ja'] as const) {
				expect(key({ site: 'FurAffinity', title: 'Ref' }, { locale })).not.toMatch(
					/already uses it|がすでに使っている/
				);
			}
		}
	});

	// url_only has two causes and the kind cannot tell them apart: the post
	// carried no date, or the date field already held one. The sentence used to
	// assert the first ("That post has no date"), which is a false claim in the
	// second — it now mirrors date_only and says only what Sona did.
	it('reads url_only from both of its causes, and claims neither', () => {
		const dateless = prefillForResult(response({ matches: [match({ postedAt: null })] }), {
			sourcePostUrl: '',
			commissionedAt: ''
		});
		const dateTaken = prefillForResult(response(), {
			sourcePostUrl: '',
			commissionedAt: '2026-01-01'
		});
		expect(statusLineKind(dateless)).toBe('url_only');
		expect(statusLineKind(dateTaken)).toBe('url_only');
		expect(m.admin_lookup_status_url_only({ site: 'FurAffinity' }, { locale: 'en' })).toBe(
			'Sona filled the source post URL from the FurAffinity post and left the commissioned date as it was. You can change the URL before you save.'
		);
		expect(m.admin_lookup_status_url_only({ site: 'FurAffinity' }, { locale: 'ja' })).toContain(
			'制作依頼日はそのままにしています。保存前にURLを変更できます。'
		);
	});
});

describe('stateFromResponse', () => {
	it('reads matches into the results state', async () => {
		const state = await stateFromResponse(jsonResponse(response()));
		expect(state).toMatchObject({ kind: 'results' });
		if (state.kind !== 'results') throw new Error('expected results');
		expect(state.data.matches).toHaveLength(1);
		expect(state.data.sourceClash).toBeNull();
	});

	// The endpoint builds every post URL, so anything that is not an https link
	// came from something that is not the endpoint — and both the panel row and
	// the upload tile render it as an anchor the operator clicks.
	it('drops a match whose handles are not an array rather than throwing later', async () => {
		const bad = { ...match({ siteId: '8' }), handles: undefined } as unknown as ReturnType<typeof match>;
		const state = await stateFromResponse(
			jsonResponse(
				response({
					matches: [bad, match({ site: 'Twitter', siteId: '9', postUrl: 'https://twitter.com/a/status/9' })]
				})
			)
		);
		if (state.kind !== 'results') throw new Error('expected results');
		expect(state.data.matches.map((x) => x.postUrl)).toEqual(['https://twitter.com/a/status/9']);
	});

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

	// Something looked and something answered; the client is the one that refused
	// the result. "No match" would tell the operator their art is unindexed.
	it('reads a result whose only match has an unusable URL as unavailable', async () => {
		expect(
			await stateFromResponse(
				jsonResponse(response({ matches: [match({ postUrl: 'javascript:alert(1)' })] }))
			)
		).toEqual({ kind: 'failed', reason: 'unavailable', sent: true });
	});

	// The panel keys its rows on site + siteId. The endpoint dedupes too; this is
	// the second pass, on the side that would throw each_key_duplicate.
	// The endpoint merges duplicates rather than dropping them; this pass has to
	// do the same, or the row the panel renders disagrees with the row the
	// endpoint built its clash check against.
	it('folds what only the duplicate knew into the row that stays', async () => {
		const state = await stateFromResponse(
			jsonResponse(
				response({
					matches: [
						match({
							site: 'Twitter',
							siteId: '160',
							handles: [],
							postedAt: null,
							rating: 'general',
							postUrl: 'https://twitter.com/i/status/160'
						}),
						match({
							site: 'Twitter',
							siteId: '160',
							handles: ['kuttoya'],
							postedAt: '2026-03-04T10:00:00Z',
							rating: 'adult',
							postUrl: 'https://twitter.com/kuttoya/status/160'
						})
					]
				})
			)
		);
		if (state.kind !== 'results') throw new Error('expected results');
		expect(state.data.matches).toHaveLength(1);
		const [row] = state.data.matches;
		expect(row.handles).toEqual(['kuttoya']);
		// A handle-less row's /i/status/ URL matches no stored
		// twitter.com/{handle}/status/{id}, so the merged row takes the twin's.
		expect(row.postUrl).toBe('https://twitter.com/kuttoya/status/160');
		expect(row.rating).toBe('adult');
		// And the date, or the commissioned date is unfillable from a post one of
		// the two copies dated.
		expect(row.postedAt).toBe('2026-03-04T10:00:00Z');
	});

	it('keeps one row per post and moves the duplicate hit onto it', async () => {
		const state = await stateFromResponse(
			jsonResponse(
				response({
					matches: [match(), match({ handles: ['kuttoya2'] })],
					localArtists: [{ matchIndex: 1, artists: [{ id: 4, name: 'Kuttoya' }] }]
				})
			)
		);
		if (state.kind !== 'results') throw new Error('expected results');
		expect(state.data.matches).toHaveLength(1);
		expect(state.data.localArtists).toEqual([{ matchIndex: 0, artists: [{ id: 4, name: 'Kuttoya' }] }]);
	});

	// Both hits now address one row, and the readers look a hit up with .find —
	// so the second one's artists have to join the first's rather than sit in an
	// entry nothing reads.
	it('unions the artists of two hits that land on the same row', async () => {
		const state = await stateFromResponse(
			jsonResponse(
				response({
					matches: [match(), match({ handles: ['kuttoya2'] })],
					localArtists: [
						{ matchIndex: 0, artists: [{ id: 4, name: 'Kuttoya' }] },
						{
							matchIndex: 1,
							artists: [
								{ id: 4, name: 'Kuttoya' },
								{ id: 7, name: 'Second' }
							]
						}
					]
				})
			)
		);
		if (state.kind !== 'results') throw new Error('expected results');
		expect(state.data.localArtists).toEqual([
			{
				matchIndex: 0,
				artists: [
					{ id: 4, name: 'Kuttoya' },
					{ id: 7, name: 'Second' }
				]
			}
		]);
		expect(candidateArtists(state.data).map((a) => a.name)).toEqual(['Kuttoya', 'Second']);
	});

	// localArtists and nameMatches address matches by index into the list as it
	// was sent, so dropping a match ahead of them has to move them along with it.
	it('re-addresses artist hits over a dropped match, and drops the hits for it', async () => {
		const state = await stateFromResponse(
			jsonResponse(
				response({
					matches: [
						match({ postUrl: 'javascript:alert(1)' }),
						match({ site: 'Twitter', siteId: '9', postUrl: 'https://twitter.com/a/status/9' })
					],
					localArtists: [
						{ matchIndex: 0, artists: [{ id: 1, name: 'Dropped' }] },
						{ matchIndex: 1, artists: [{ id: 2, name: 'Kept' }] }
					],
					nameMatches: [{ matchIndex: 1, artists: [{ id: 3, name: 'By name' }] }]
				})
			)
		);
		if (state.kind !== 'results') throw new Error('expected results');
		expect(state.data.localArtists).toEqual([{ matchIndex: 0, artists: [{ id: 2, name: 'Kept' }] }]);
		expect(state.data.nameMatches).toEqual([{ matchIndex: 0, artists: [{ id: 3, name: 'By name' }] }]);
		// The hit now points at the match it belongs to, so the panel still offers it.
		expect(candidateArtists(state.data).map((a) => a.name)).toEqual(['Kept']);
	});

	it('reads an empty match list as no_match', async () => {
		expect(await stateFromResponse(jsonResponse({ enabled: true, matches: [] }))).toEqual({
			kind: 'no_match'
		});
	});

	// An empty list says nobody has this piece. A 200 with no list at all, or one
	// whose `matches` is not an array, says nothing about the piece: the response
	// is malformed and nobody looked. Reading it as no_match told the operator
	// their art is unindexed, which is a different and wrong fact.
	it('refuses to call a body with no match list a no_match', async () => {
		expect(await stateFromResponse(jsonResponse({ enabled: true }))).toEqual({
			kind: 'failed',
			reason: 'unavailable',
			sent: true
		});
		expect(await stateFromResponse(jsonResponse({ enabled: true, matches: 'x' }))).toEqual({
			kind: 'failed',
			reason: 'unavailable',
			sent: true
		});
		// And the disclosure still reads the endpoint rather than assuming: a body
		// that says the file never left is taken at its word.
		expect(await stateFromResponse(jsonResponse({ enabled: true, forwarded: false }))).toEqual({
			kind: 'failed',
			reason: 'unavailable',
			sent: false
		});
	});

	// The upstream side: FuzzySearch answered, so the bytes had already gone out
	// and the endpoint says so with forwarded: true.
	it('maps an upstream failure by the body error, not by the status', async () => {
		const cases = [
			['key_refused', 424],
			['rate_limited', 429],
			['too_large', 413],
			['invalid_image', 422],
			['unavailable', 502]
		] as const;
		for (const [error, status] of cases) {
			expect(
				await stateFromResponse(
					jsonResponse({ enabled: true, error, forwarded: true }, status)
				)
			).toEqual({
				kind: 'failed',
				reason: error,
				sent: true
			});
		}
	});

	// The gate side: the endpoint's own checks answer too_large and invalid_image
	// with the same reasons and statuses FuzzySearch's 413/400 arrive as, so only
	// `forwarded` tells them apart — and the disclosure hangs on it.
	it('reads a gate refusal off forwarded, however it is reasoned', async () => {
		const cases = [
			['too_large', 413],
			['invalid_image', 422],
			['unavailable', 502]
		] as const;
		for (const [error, status] of cases) {
			expect(
				await stateFromResponse(
					jsonResponse({ enabled: true, error, forwarded: false }, status)
				)
			).toEqual({
				kind: 'failed',
				reason: error,
				sent: false
			});
		}
	});

	// The exits the endpoint answers by throwing (no file in the multipart body,
	// a bad image id) carry no `error` field — SvelteKit serializes the error
	// body — but they do carry forwarded: false, and a private image must not be
	// reported as having reached FuzzySearch. The 404 of a deleted image has its
	// own reason; it is pinned below.
	it('reads a SvelteKit error body as unavailable and not sent', async () => {
		for (const [body, status] of [
			[{ message: 'No file provided', forwarded: false }, 400],
			[{ message: 'Invalid image id', forwarded: false }, 400]
		] as const) {
			expect(await stateFromResponse(jsonResponse(body, status))).toEqual({
				kind: 'failed',
				reason: 'unavailable',
				sent: false
			});
		}
	});

	// An endpoint that says nothing about which side refused is one this client
	// cannot date, so the disclosure errs toward saying the file went.
	it('counts a failure body with no forwarded field as sent', async () => {
		expect(await stateFromResponse(jsonResponse({ enabled: true, error: 'too_large' }, 413))).toEqual({
			kind: 'failed',
			reason: 'too_large',
			sent: true
		});
	});

	it('treats an expired admin session as "sign in again", never as a refused key', async () => {
		// The admin gate answers with plain text, so this must not be parsed.
		const gate = new Response('Unauthorized', {
			status: 401,
			headers: { 'content-type': 'text/plain' }
		});
		expect(await stateFromResponse(gate)).toEqual({
			kind: 'failed',
			reason: 'signed_out',
			sent: false
		});
	});

	it('falls back to unavailable for a body it cannot read', async () => {
		const html = new Response('<html>proxy</html>', {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});
		expect(await stateFromResponse(html)).toEqual({
			kind: 'failed',
			reason: 'unavailable',
			sent: true
		});

		const broken = new Response('{', { status: 200, headers: { 'content-type': 'application/json' } });
		expect(await stateFromResponse(broken)).toEqual({
			kind: 'failed',
			reason: 'unavailable',
			sent: true
		});

		const unknownError = jsonResponse({ enabled: true, error: 'something new' }, 500);
		expect(await stateFromResponse(unknownError)).toEqual({
			kind: 'failed',
			reason: 'unavailable',
			sent: true
		});
	});

	// The endpoint answers enabled:false before it reads the body, so the file
	// was never forwarded and the private-image notice must not claim it was.
	// Its own reason too: nothing was asked of FuzzySearch, so the panel points
	// at Settings instead of saying FuzzySearch didn't answer.
	it('treats a key that went away mid-session as a missing key, not an outage', async () => {
		const state = await stateFromResponse(jsonResponse({ enabled: false }));
		expect(state).toEqual({
			kind: 'failed',
			reason: 'no_key',
			sent: false
		});
		expect(lookupSentFile(state)).toBe(false);
	});

	// The image was deleted between the page load and the click. The endpoint's
	// shaped 404 names no `error`, so the generic mapping read it as an outage
	// and the panel said FuzzySearch didn't answer — about a lookup FuzzySearch
	// was never asked to run.
	it('treats a deleted image as gone, not as an outage', async () => {
		const state = await stateFromResponse(
			jsonResponse({ message: 'Image not found', forwarded: false }, 404)
		);
		expect(state).toEqual({ kind: 'failed', reason: 'gone', sent: false });
		expect(lookupSentFile(state)).toBe(false);
	});

	// Only the shaped body. A 404 that DOES name a reason keeps it — 'gone' is
	// the client's reading of a body with nothing to read, not a status map.
	it('keeps the error a 404 names, where it names one', async () => {
		expect(
			await stateFromResponse(jsonResponse({ enabled: true, error: 'rate_limited' }, 404))
		).toEqual({ kind: 'failed', reason: 'rate_limited', sent: true });
	});
});

describe('lookupSentFile', () => {
	// The disclosure is about the FILE having left the browser, not about the
	// lookup having worked: it belongs on a failure just as much as on a result.
	it('is true for every outcome the request actually reached', () => {
		expect(lookupSentFile({ kind: 'results', data: response() })).toBe(true);
		expect(lookupSentFile({ kind: 'no_match' })).toBe(true);
		for (const reason of ['key_refused', 'rate_limited', 'unavailable'] as const) {
			expect(lookupSentFile({ kind: 'failed', reason, sent: true })).toBe(true);
		}
	});

	// The two refusals that happen before any request goes out: runLookup's own
	// size check, and the admin gate's 401. Claiming the file went out would be a
	// false disclosure.
	it('is false for the refusals that never left the browser', () => {
		expect(lookupSentFile({ kind: 'failed', reason: 'too_large', sent: false })).toBe(false);
		expect(lookupSentFile({ kind: 'failed', reason: 'signed_out', sent: false })).toBe(false);
	});

	// The reason alone cannot answer this: too_large and invalid_image each come
	// from a gate that runs before anything is forwarded AND from FuzzySearch
	// answering 413/400 after the file was sent. The flag is what decides.
	it('reads the flag, not the reason', () => {
		for (const reason of ['too_large', 'invalid_image'] as const) {
			expect(lookupSentFile({ kind: 'failed', reason, sent: true })).toBe(true);
			expect(lookupSentFile({ kind: 'failed', reason, sent: false })).toBe(false);
		}
	});

	it('says nothing before an outcome exists', () => {
		expect(lookupSentFile({ kind: 'idle' })).toBe(false);
		expect(lookupSentFile({ kind: 'searching' })).toBe(false);
	});
});

// What the upload page's catch puts on the tile when applying a settled result
// threw. The request itself is over by then, so the only question the flag
// answers is whether the bytes ever left — and only a failure knows.
describe('sentAfterApplyThrew', () => {
	it.each([
		['a failure the browser refused to send', { kind: 'failed', reason: 'too_large', sent: false }, false],
		['a failure that went out', { kind: 'failed', reason: 'rate_limited', sent: true }, true],
		['a result', { kind: 'results', data: response() }, true],
		['a no-match', { kind: 'no_match' }, true],
		// Cancelled or re-fired, never a state the request settles on: it reaches
		// this only if the capture itself is what threw, and by then the request
		// had gone out.
		['a state still searching', { kind: 'searching' }, true]
	] as [string, LookupState, boolean][])('is %s -> %s', (_label, settled, expected) => {
		expect(sentAfterApplyThrew(settled)).toBe(expected);
	});

	// A throw early enough that nothing was captured: the request was already in
	// flight, so it errs the same way runLookup's own network catch does.
	it('assumes the file went when it captured nothing', () => {
		expect(sentAfterApplyThrew(null)).toBe(true);
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
		expect(state).toEqual({ kind: 'failed', reason: 'too_large', sent: false });
		expect(called).toBe(false);
	});

	// The other origin of the same two reasons: FuzzySearch answered 413 or 400
	// after the file had already gone out, so the disclosure has to say so. The
	// endpoint's `forwarded` is what separates this from the same reasons raised
	// by its own gates, which the case below pins.
	it('marks a size or format refusal that came back from FuzzySearch as sent', async () => {
		for (const [error, status] of [
			['too_large', 413],
			['invalid_image', 400]
		] as const) {
			const state = await runLookup(
				{ imageId: 1 },
				{
					fetchFn: (async () =>
						jsonResponse(
							{ enabled: true, error, forwarded: true },
							status
						)) as unknown as typeof fetch
				}
			);
			expect(state).toEqual({ kind: 'failed', reason: error, sent: true });
			expect(lookupSentFile(state)).toBe(true);
		}
	});

	// The edit page holds no bytes to size-check, so a stored image the endpoint
	// refuses is refused there — same reason, same status, nothing forwarded.
	it('marks a size or format refusal raised by the endpoint gate as not sent', async () => {
		for (const [error, status] of [
			['too_large', 413],
			['invalid_image', 422]
		] as const) {
			const state = await runLookup(
				{ imageId: 1 },
				{
					fetchFn: (async () =>
						jsonResponse(
							{ enabled: true, error, forwarded: false },
							status
						)) as unknown as typeof fetch
				}
			);
			expect(state).toEqual({ kind: 'failed', reason: error, sent: false });
			expect(lookupSentFile(state)).toBe(false);
		}
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
		expect(state).toEqual({ kind: 'failed', reason: 'unavailable', sent: true });
	});
});

// The panel's seed sentences and the clash row's size, in both locales. Copy
// pins rather than style notes: the seed lines carry the compliance clause
// ("a guess until you check them, and you're the one publishing them") that the
// dialog's own guess line carries, and they used to tell the operator to check
// twice in two consecutive sentences.
describe('the seed status copy', () => {
	const locales = ['en', 'ja'] as const;

	it('keeps the guess-and-publish clause without the extra imperative', () => {
		for (const locale of locales) {
			const both = m.admin_lookup_status_seed_both({ site: 'FurAffinity' }, { locale });
			const name = m.admin_lookup_status_seed_name({}, { locale });
			const link = m.admin_lookup_status_seed_link({ site: 'FurAffinity' }, { locale });
			const clause = locale === 'en' ? "you're the one publishing" : '公開するのはあなたです';
			const dropped = locale === 'en' ? 'before you save' : '保存前に';
			for (const line of [both, name, link]) {
				expect(line).toContain(clause);
				expect(line).not.toContain(dropped);
			}
		}
	});

	it('sizes the clash row with a multiplication sign, not the letter x', () => {
		for (const locale of locales) {
			const size = m.admin_lookup_clash_dimensions({ width: 2048, height: 1536 }, { locale });
			expect(size).toBe('2048 × 1536');
		}
	});
});
