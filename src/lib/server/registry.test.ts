import { describe, it, expect } from 'vitest';
import { isRegistryEnabled, artistSocials, firstHandle, parseAliases } from './registry';

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
