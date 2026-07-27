import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	twitterHandleFromUrl,
	parseUserAvatar,
	to400x400,
	fetchTwitterAvatar
} from './twitter-avatar';

describe('twitterHandleFromUrl', () => {
	it('handles the stored URL shapes', () => {
		expect(twitterHandleFromUrl('https://x.com/@ExampleFox/')).toBe('examplefox');
		expect(twitterHandleFromUrl('https://twitter.com/examplefox')).toBe('examplefox');
		expect(twitterHandleFromUrl('https://mobile.twitter.com/examplefox?s=21')).toBe('examplefox');
		expect(twitterHandleFromUrl('@examplefox')).toBe('examplefox');
		expect(twitterHandleFromUrl('x.com/examplefox/status/123')).toBe('examplefox');
	});

	it('returns empty for junk', () => {
		expect(twitterHandleFromUrl('https://x.com/')).toBe('');
		expect(twitterHandleFromUrl('')).toBe('');
	});
});

describe('parseUserAvatar', () => {
	it('prefers the modern avatar shape and falls back to legacy', () => {
		expect(
			parseUserAvatar({
				data: { user: { result: { avatar: { image_url: 'https://pbs.twimg.com/a_normal.jpg' } } } }
			})
		).toBe('https://pbs.twimg.com/a_normal.jpg');
		expect(
			parseUserAvatar({
				data: { user: { result: { legacy: { profile_image_url_https: 'https://pbs.twimg.com/b_normal.jpg' } } } }
			})
		).toBe('https://pbs.twimg.com/b_normal.jpg');
	});

	it('returns null on suspended/missing users and junk', () => {
		expect(parseUserAvatar({ data: { user: {} } })).toBeNull();
		expect(parseUserAvatar(null)).toBeNull();
	});
});

describe('to400x400', () => {
	it('upgrades the _normal variant and leaves others alone', () => {
		expect(to400x400('https://pbs.twimg.com/profile_images/1/a_normal.jpg')).toBe(
			'https://pbs.twimg.com/profile_images/1/a_400x400.jpg'
		);
		expect(to400x400('https://pbs.twimg.com/profile_images/1/a.jpg')).toBe(
			'https://pbs.twimg.com/profile_images/1/a.jpg'
		);
	});
});

describe('fetchTwitterAvatar', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const userBody = {
		data: {
			user: {
				result: { legacy: { profile_image_url_https: 'https://pbs.twimg.com/profile_images/9/pic_normal.jpg' } }
			}
		}
	};

	it('activates a guest token and resolves the 400x400 avatar', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) => {
				if (String(url).includes('guest/activate')) {
					return new Response(JSON.stringify({ guest_token: 'gt' }), { status: 200 });
				}
				return new Response(JSON.stringify(userBody), { status: 200 });
			})
		);
		expect(await fetchTwitterAvatar('https://x.com/examplefox')).toBe(
			'https://pbs.twimg.com/profile_images/9/pic_400x400.jpg'
		);
	});

	it('retries once with a fresh token on 429, then succeeds', async () => {
		let activations = 0;
		let lookups = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL) => {
				if (String(url).includes('guest/activate')) {
					activations++;
					return new Response(JSON.stringify({ guest_token: `gt-${activations}` }), { status: 200 });
				}
				lookups++;
				if (lookups === 1) return new Response('rate limited', { status: 429 });
				return new Response(JSON.stringify(userBody), { status: 200 });
			})
		);
		expect(await fetchTwitterAvatar('https://x.com/examplefox')).toContain('_400x400');
		expect(activations).toBe(2);
	});

	it('fails soft to null on activation failure, refusal, or network errors', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 403 })));
		expect(await fetchTwitterAvatar('https://x.com/examplefox')).toBeNull();

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('down');
			})
		);
		expect(await fetchTwitterAvatar('https://x.com/examplefox')).toBeNull();
	});
});
