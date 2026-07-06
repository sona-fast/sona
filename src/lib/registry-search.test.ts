import { describe, it, expect } from 'vitest';
import { shouldSearch, resultToPrefill, type RegResult } from './registry-search';

describe('shouldSearch', () => {
	it('gates out queries shorter than 2 non-space chars', () => {
		expect(shouldSearch('')).toBe(false);
		expect(shouldSearch(' ')).toBe(false);
		expect(shouldSearch('a')).toBe(false);
		expect(shouldSearch(' a ')).toBe(false);
	});
	it('allows queries of 2+ trimmed chars', () => {
		expect(shouldSearch('ab')).toBe(true);
		expect(shouldSearch('  lunarpaws  ')).toBe(true);
	});
});

describe('resultToPrefill', () => {
	const full: RegResult = {
		globalId: 'g-1',
		name: 'Lunar Paws',
		avatarUrl: 'https://cdn/avatar.png',
		version: 7,
		socials: {
			twitterUrl: 'https://x.com/lunarpaws',
			blueskyUrl: 'https://bsky.app/profile/lunarpaws',
			telegramUrl: 'https://t.me/lunarpaws',
			furAffinityUrl: 'https://furaffinity.net/user/lunarpaws',
			deviantArtUrl: 'https://deviantart.com/lunarpaws',
			patreonUrl: 'https://patreon.com/lunarpaws',
			instagramUrl: 'https://instagram.com/lunarpaws'
		}
	};

	it('maps every social field and the pull-link record', () => {
		expect(resultToPrefill(full)).toEqual({
			name: 'Lunar Paws',
			twitter: 'https://x.com/lunarpaws',
			bluesky: 'https://bsky.app/profile/lunarpaws',
			telegram: 'https://t.me/lunarpaws',
			furaffinity: 'https://furaffinity.net/user/lunarpaws',
			deviantart: 'https://deviantart.com/lunarpaws',
			patreon: 'https://patreon.com/lunarpaws',
			instagram: 'https://instagram.com/lunarpaws',
			pulled: { globalId: 'g-1', version: 7, avatarUrl: 'https://cdn/avatar.png' }
		});
	});

	it('defaults missing socials to empty strings and preserves a null avatar', () => {
		const sparse: RegResult = { globalId: 'g-2', name: 'Solo', avatarUrl: null, version: 1, socials: {} };
		const out = resultToPrefill(sparse);
		expect(out.name).toBe('Solo');
		expect(out.twitter).toBe('');
		expect(out.instagram).toBe('');
		expect(out.pulled).toEqual({ globalId: 'g-2', version: 1, avatarUrl: null });
	});
});
