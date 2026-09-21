import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	isFatalRefusal,
	isRegistryEnabled,
	isRegistryRefusal,
	artistSocials,
	firstHandle,
	isLocalNameAliasOf,
	parseAliases,
	registryDelta,
	registrySearch,
	registryRegisterFork,
	registrySubmit,
	resolveRegistryEnv,
	REGISTRY_API_KEY_SETTING,
	REGISTRY_URL_SETTING,
	type RegistryArtist
} from './registry';
import { getRawSetting } from './settings';

vi.mock('./settings', () => ({ getRawSetting: vi.fn() }));

const mockGetRawSetting = vi.mocked(getRawSetting);

describe('isRegistryEnabled', () => {
	it('is true only when a fork API key is present', () => {
		expect(isRegistryEnabled(undefined)).toBe(false);
		expect(isRegistryEnabled({} as App.Platform['env'])).toBe(false);
		expect(isRegistryEnabled({ REGISTRY_API_KEY: 'k' } as App.Platform['env'])).toBe(true);
	});
});

describe('artistSocials / firstHandle', () => {
	it('collects only non-empty social url fields', () => {
		const socials = artistSocials({
			twitterUrl: 'https://x.com/a',
			blueskyUrl: '',
			telegramUrl: null,
			furAffinityUrl: 'https://furaffinity.net/user/b'
		});
		expect(socials).toEqual({
			twitterUrl: 'https://x.com/a',
			furAffinityUrl: 'https://furaffinity.net/user/b'
		});
	});

	it('firstHandle returns the first non-empty social or null', () => {
		expect(firstHandle({ twitterUrl: 'https://x.com/a' })).toBe('https://x.com/a');
		expect(firstHandle({ twitterUrl: '', blueskyUrl: 'bsky' })).toBe('bsky');
		expect(firstHandle({})).toBeNull();
	});
});

describe('parseAliases', () => {
	it('returns [] for null / empty / malformed input', () => {
		expect(parseAliases(null)).toEqual([]);
		expect(parseAliases(undefined)).toEqual([]);
		expect(parseAliases('')).toEqual([]);
		expect(parseAliases('not json')).toEqual([]);
		expect(parseAliases('{"displayName":"x"}')).toEqual([]); // not an array
	});

	it('keeps only entries with a non-empty displayName', () => {
		const json = JSON.stringify([
			{ displayName: 'KesForge', socials: { twitterUrl: 'https://x.com/kf' } },
			{ displayName: '', socials: {} },
			{ socials: {} },
			{ displayName: 'OldName', socials: {} }
		]);
		expect(parseAliases(json)).toEqual([
			{ displayName: 'KesForge', socials: { twitterUrl: 'https://x.com/kf' } },
			{ displayName: 'OldName', socials: {} }
		]);
	});
});

describe('isLocalNameAliasOf', () => {
	type Reg = Parameters<typeof isLocalNameAliasOf>[1];

	it('is true when the local name matches an alias (case-insensitive)', () => {
		const reg: Reg = {
			displayName: 'Buttsteak',
			aliases: [{ displayName: 'Mlyeko', socials: {} }]
		};
		expect(isLocalNameAliasOf('mlyeko', reg)).toBe(true);
	});

	it('displayName takes precedence: a name that is BOTH the displayName and an alias is not an alias link', () => {
		const reg: Reg = {
			displayName: 'Buttsteak',
			aliases: [{ displayName: 'Buttsteak', socials: {} }]
		};
		expect(isLocalNameAliasOf('Buttsteak', reg)).toBe(false);
	});

	it('is false (no throw) when aliases is undefined', () => {
		expect(isLocalNameAliasOf('anyone', { displayName: 'Buttsteak' })).toBe(false);
	});

	it('tolerates malformed alias entries and still matches the valid one', () => {
		const reg = {
			displayName: 'Buttsteak',
			aliases: [null, { displayName: 42 }, { socials: {} }, { displayName: 'CinnamonServal' }]
		} as unknown as Reg;
		expect(isLocalNameAliasOf('cinnamonserval', reg)).toBe(true);
	});

	it('fails open (false, no throw) when the registry entry lacks a string displayName', () => {
		const reg = { aliases: [{ displayName: 'Mlyeko', socials: {} }] } as unknown as Reg;
		expect(isLocalNameAliasOf('mlyeko', reg)).toBe(false);
		expect(isLocalNameAliasOf('mlyeko', { displayName: 42 } as unknown as Reg)).toBe(false);
	});

	it('matches across Unicode normal forms (NFC local vs NFD alias)', () => {
		const reg: Reg = {
			displayName: 'Buttsteak',
			aliases: [{ displayName: 'Re\u0301my', socials: {} }] // NFD (e + combining acute)
		};
		expect(isLocalNameAliasOf('R\u00e9my', reg)).toBe(true); // NFC (precomposed é)
	});
});

describe('registryRegisterFork', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('returns forkId + key on a successful POST /v1/forks', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ forkId: 'f1', key: 'secret-key' }), { status: 201 })
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await registryRegisterFork({ signupToken: 'invite' });
		expect(result).toEqual({ forkId: 'f1', key: 'secret-key' });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toMatch(/\/v1\/forks$/);
		expect(JSON.parse(init.body as string)).toEqual({ signupToken: 'invite', label: undefined });
	});

	it('surfaces the registry error message on a non-ok response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'invalid token' }), { status: 400 })
			)
		);
		const result = await registryRegisterFork({ signupToken: 'bad' });
		expect(result).toEqual({ error: 'invalid token' });
	});

	it('returns an error when the registry does not respond', async () => {
		// withTimeout swallows the rejection and yields its null fallback.
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
		const result = await registryRegisterFork({ signupToken: 'x' });
		expect(result).toEqual({
			error: 'the registry did not respond — check the URL and try again'
		});
	});
});

describe('isRegistryRefusal', () => {
	it('is true only for the typed refusal shape', () => {
		expect(isRegistryRefusal({ error: 'invalid fork key', httpStatus: 401 })).toBe(true);
	});

	it('is false for every success / empty shape', () => {
		expect(isRegistryRefusal([])).toBe(false); // an empty catalog is not a refusal
		expect(isRegistryRefusal({})).toBe(false);
		expect(isRegistryRefusal(null)).toBe(false);
		expect(isRegistryRefusal(undefined)).toBe(false);
		expect(isRegistryRefusal({ artists: [], nextCursor: null })).toBe(false);
		const catalog: Pick<RegistryArtist, 'globalId' | 'displayName'>[] = [
			{ globalId: 'g1', displayName: 'Nyx' }
		];
		expect(isRegistryRefusal(catalog)).toBe(false);
	});

	it('is false when the fields are the wrong type or ride along a success payload', () => {
		// Untrusted wire data: duck-typing on field PRESENCE would let a 200 page that
		// happens to carry these keys read as a refusal to every caller.
		expect(isRegistryRefusal({ error: 401, httpStatus: 'nope' })).toBe(false);
		expect(isRegistryRefusal({ error: 'x', httpStatus: '401' })).toBe(false);
		expect(isRegistryRefusal({ error: 'x', httpStatus: 401, artists: [] })).toBe(false);
	});
});

describe('isFatalRefusal', () => {
	it('is true only for the auth statuses (401/403)', () => {
		expect(isFatalRefusal(401)).toBe(true);
		expect(isFatalRefusal(403)).toBe(true);
	});

	// A rate-limit / timeout / validation error is transient or narrow: failing a whole
	// sync or import run for it turns a self-correcting condition into a failed job.
	it('is false for transient 4xx statuses', () => {
		expect(isFatalRefusal(429)).toBe(false);
		expect(isFatalRefusal(408)).toBe(false);
		expect(isFatalRefusal(400)).toBe(false);
		expect(isFatalRefusal(409)).toBe(false);
	});
});

describe('registry client — authenticated calls never follow a redirect', () => {
	afterEach(() => vi.unstubAllGlobals());
	const env = { REGISTRY_API_KEY: 'fork-key' } as App.Platform['env'];

	// REGISTRY_URL is operator-set, and fetch replays the bearer header at whatever
	// origin a 3xx names. Manual redirect mode hands the 3xx back as a plain non-ok
	// response, which fails soft like any other, and the key stays home.
	it('sends the delta request with redirect: manual and treats a 302 as a soft failure', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
		);
		vi.stubGlobal('fetch', fetchMock);
		const onFail = vi.fn();

		expect(await registryDelta(env, {}, { onFail })).toEqual({ artists: [], nextCursor: null });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
		expect(onFail).toHaveBeenCalledTimes(1);
		expect(onFail.mock.calls[0][0]).toMatch(/HTTP 302/);
	});

	it('leaves redirect mode alone on the public search call', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ artists: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
		);
		vi.stubGlobal('fetch', fetchMock);
		await registrySearch(env, { handle: 'x' });
		expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBeUndefined();
	});
});

describe('registryDelta', () => {
	afterEach(() => vi.unstubAllGlobals());
	const env = { REGISTRY_API_KEY: 'fork-key' } as App.Platform['env'];

	it('GETs the delta feed with the auth header', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ artists: [], nextCursor: null })));
		vi.stubGlobal('fetch', fetchMock);

		const result = await registryDelta(env, { updatedSince: '2026-01-01T00:00:00Z', limit: 100 });
		expect(result).toEqual({ artists: [], nextCursor: null });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toContain('/v1/artists?updated_since=');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer fork-key');
	});

	it('surfaces a 401 as a typed refusal instead of an empty page', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'invalid fork key' }), { status: 401 })
			)
		);
		expect(await registryDelta(env, {})).toEqual({ error: 'invalid fork key', httpStatus: 401 });
	});

	// A JSON error body on purpose: with a non-JSON body this would pass via the
	// parse fallback even if the refusal range were widened to every non-ok status,
	// so it would stop guarding the 4xx-only rule.
	it('still fails soft (empty page) on a 5xx', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'registry down' }), {
					status: 502,
					headers: { 'content-type': 'application/json' }
				})
			)
		);
		expect(await registryDelta(env, {})).toEqual({ artists: [], nextCursor: null });
	});

	// Anything in front of the registry (a WAF, an Access login page) answers 4xx with
	// HTML. Without a usable `error` string that used to fall through to the empty-page
	// fallback — the silent empty catalogue this whole path exists to remove.
	it.each([
		['an HTML body', 403, 'error 1020: Access denied', 'HTTP 403'],
		['a JSON body with no `error` field', 401, JSON.stringify({ message: 'unauthorized' }), 'HTTP 401'],
		['an empty `error` string', 401, JSON.stringify({ error: '' }), 'HTTP 401'],
		['a whitespace-only `error` string', 429, JSON.stringify({ error: '  \n' }), 'HTTP 429']
	])('still reports a refusal for a 4xx with %s', async (_label, status, body, expected) => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));
		expect(await registryDelta(env, {})).toEqual({ error: expected, httpStatus: status, opaque: true });
	});

	it('returns an empty page (and sends nothing) when the registry is not configured', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		expect(await registryDelta(undefined, {})).toEqual({ artists: [], nextCursor: null });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('registrySubmit', () => {
	afterEach(() => vi.unstubAllGlobals());
	const env = { REGISTRY_API_KEY: 'fork-key' } as App.Platform['env'];

	it('POSTs to /v1/submissions with the auth header and forwards siteLabel', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ id: 1, status: 'pending', matchedGlobalId: null }), { status: 201 })
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await registrySubmit(env, {
			kind: 'create',
			siteLabel: 'sparky.ink',
			payload: { displayName: 'Nyx', socials: {} }
		});
		expect(result).toEqual({ id: 1, status: 'pending', matchedGlobalId: null });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toMatch(/\/v1\/submissions$/);
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer fork-key');
		// The fork's self-reported host rides along on the submission for backfill.
		expect(JSON.parse(init.body as string)).toMatchObject({ siteLabel: 'sparky.ink' });
	});

	it('surfaces a 4xx refusal body (tombstoned match) instead of failing soft', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						error: 'This artist was removed from the registry and cannot be resubmitted.',
						matchedGlobalId: 'g-ghost',
						tombstoned: true
					}),
					{ status: 409 }
				)
			)
		);
		const result = await registrySubmit(env, {
			kind: 'create',
			siteLabel: 'sparky.ink',
			payload: { displayName: 'Ghost', socials: { twitterUrl: 'https://x.com/ghostpaws' } }
		});
		expect(result).toMatchObject({
			error: expect.stringMatching(/removed from the registry/i),
			httpStatus: 409
		});
	});

	it('passes the refusal HTTP status through (429 rate-limit, not a blanket 409)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'Too many submissions — slow down.' }), {
					status: 429
				})
			)
		);
		const result = await registrySubmit(env, {
			kind: 'create',
			siteLabel: 'sparky.ink',
			payload: { displayName: 'Rapid', socials: {} }
		});
		expect(result).toMatchObject({ error: expect.any(String), httpStatus: 429 });
	});

	it('still fails soft (null) on a 5xx', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('gateway broke', { status: 502 }))
		);
		const result = await registrySubmit(env, {
			kind: 'create',
			siteLabel: 'sparky.ink',
			payload: { displayName: 'A', socials: {} }
		});
		expect(result).toBeNull();
	});

	it('returns null (and sends nothing) when the registry is not configured', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const result = await registrySubmit(undefined, {
			kind: 'create',
			siteLabel: 'x',
			payload: { displayName: 'A', socials: {} }
		});
		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('resolveRegistryEnv', () => {
	afterEach(() => mockGetRawSetting.mockReset());
	const db = {} as Parameters<typeof resolveRegistryEnv>[0];

	it('returns env untouched (no DB read) when a deploy-time secret is set', async () => {
		const env = { REGISTRY_API_KEY: 'secret' } as App.Platform['env'];
		expect(await resolveRegistryEnv(db, env)).toBe(env);
		expect(mockGetRawSetting).not.toHaveBeenCalled();
	});

	it('returns env unchanged when no stored fork key exists', async () => {
		mockGetRawSetting.mockResolvedValue(null);
		const env = {} as App.Platform['env'];
		expect(await resolveRegistryEnv(db, env)).toBe(env);
	});

	it('overlays the stored fork key and URL onto env', async () => {
		mockGetRawSetting.mockImplementation(async (_db, key) =>
			key === REGISTRY_API_KEY_SETTING ? 'stored-key' : key === REGISTRY_URL_SETTING ? 'https://r.example' : null
		);
		const resolved = await resolveRegistryEnv(db, {} as App.Platform['env']);
		expect(resolved?.REGISTRY_API_KEY).toBe('stored-key');
		expect(resolved?.REGISTRY_URL).toBe('https://r.example');
	});
});

describe('registry client — naming what answered instead of the registry', () => {
	afterEach(() => vi.unstubAllGlobals());
	const env = { REGISTRY_API_KEY: 'fork-key' } as App.Platform['env'];

	// A zone-level bot challenge (Bot Fight Mode, 2026-09-17) answers a Worker fetch
	// with an HTML page, a 403, and `cf-mitigated: challenge`. Reporting that as a bare
	// "HTTP 403" reads as a fork-key problem and sent the investigation the wrong way;
	// the header names the actual product, and cf-ray points at the security event.
	// The ray travels as "<id> <colo>", not as the raw "<id>-<colo>": job_run.detail
	// redacts any token-like run of 20+ characters, and the joined form is exactly 20,
	// so the panel used to show "(cf-ray [redacted])" — the one detail worth keeping.
	it('names a Cloudflare mitigation (and its cf-ray) on an opaque 4xx refusal', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('<html>Just a moment...</html>', {
					status: 403,
					headers: {
						'content-type': 'text/html',
						'cf-mitigated': 'challenge',
						'cf-ray': 'a3e7bc522cbfa3c2-SEA'
					}
				})
			)
		);
		expect(await registryDelta(env, {})).toEqual({
			error:
				'HTTP 403: blocked by a Cloudflare challenge in front of the registry (cf-ray a3e7bc522cbfa3c2 SEA)',
			httpStatus: 403,
			opaque: true
		});
	});

	// Neither header comes from the registry on this path — whatever blocked the call
	// set them — so an off-shape value is dropped instead of being pasted into a job
	// log and an operator toast.
	it('ignores an off-shape cf-mitigated and cf-ray, falling back to the bare status', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('<html/>', {
					status: 403,
					headers: {
						'cf-mitigated': 'challenge'.repeat(20),
						'cf-ray': 'not a real ray id at all'
					}
				})
			)
		);
		expect(await registryDelta(env, {})).toEqual({ error: 'HTTP 403', httpStatus: 403, opaque: true });
	});

	it('keeps the registry\'s own reason when the body has one, even behind Cloudflare headers', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ error: 'invalid fork key' }), {
					status: 401,
					headers: { 'content-type': 'application/json', 'cf-ray': 'abc123-SEA' }
				})
			)
		);
		expect(await registryDelta(env, {})).toEqual({ error: 'invalid fork key', httpStatus: 401 });
	});

	// The search endpoint has always failed soft (empty list), which is right for one
	// call and invisible across a whole run. The hook lets the caller count and name
	// the failures without changing the empty-list contract.
	// The status rides along so a caller can tell back-pressure (429/408) from an
	// outage; it is undefined when nothing answered at all.
	it.each([
		['a 5xx', () => Promise.resolve(new Response('bad gateway', { status: 502 })), /HTTP 502/, 502],
		[
			'a challenge page',
			() =>
				Promise.resolve(
					new Response('<html/>', { status: 403, headers: { 'cf-mitigated': 'challenge' } })
				),
			/blocked by a Cloudflare challenge/,
			403
		],
		[
			'a rate limit',
			() => Promise.resolve(new Response('slow down', { status: 429 })),
			/HTTP 429/,
			429
		],
		['a network error', () => Promise.reject(new Error('offline')), /offline/, undefined]
	])('registrySearch still returns [] on %s but reports the reason through onFail', async (_l, fetchImpl, expected, status) => {
		vi.stubGlobal('fetch', vi.fn(fetchImpl));
		const onFail = vi.fn();
		expect(await registrySearch(env, { handle: 'x' }, { onFail })).toEqual([]);
		expect(onFail).toHaveBeenCalledTimes(1);
		expect(onFail.mock.calls[0][0]).toMatch(expected);
		expect(onFail.mock.calls[0][1]?.httpStatus).toBe(status);
	});

	// The timeout arm: withTimeout resolves to null with nothing to report, so the
	// reason has to be synthesized. Without this the slowest failure mode — the one
	// an overloaded registry actually produces — would report no reason at all.
	it('reports a timeout through onFail when nothing ever answers', async () => {
		vi.useFakeTimers();
		try {
			vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
			const onFail = vi.fn();
			const pending = registrySearch(env, { handle: 'x' }, { onFail });
			await vi.advanceTimersByTimeAsync(5001);
			expect(await pending).toEqual([]);
			expect(onFail).toHaveBeenCalledTimes(1);
			expect(onFail.mock.calls[0][0]).toMatch(/timed out/);
			expect(onFail.mock.calls[0][1]?.httpStatus).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not call onFail on a healthy search', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ artists: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
			)
		);
		const onFail = vi.fn();
		await registrySearch(env, { handle: 'x' }, { onFail });
		expect(onFail).not.toHaveBeenCalled();
	});
});
