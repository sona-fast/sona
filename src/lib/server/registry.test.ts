import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	isRegistryEnabled,
	artistSocials,
	firstHandle,
	parseAliases,
	registryRegisterFork,
	registrySubmit,
	resolveRegistryEnv,
	REGISTRY_API_KEY_SETTING,
	REGISTRY_URL_SETTING
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
