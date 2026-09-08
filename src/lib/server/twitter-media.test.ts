import { describe, expect, it, vi } from 'vitest';
import { fetchTweetMediaUrl, parseTweetPhotoUrl, tweetIdFromUrl } from './twitter-media';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Shaped like the real TweetResultByRestId response, trimmed to what we read. */
const tweetWith = (media: unknown[]) => ({
	data: {
		tweetResult: {
			result: {
				__typename: 'Tweet',
				legacy: { extended_entities: { media } }
			}
		}
	}
});

const photo = { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/AbCdEf123.jpg' };

describe('tweetIdFromUrl', () => {
	it('reads the id out of the accepted shapes', () => {
		expect(tweetIdFromUrl('https://x.com/examplefox/status/1234567890')).toBe('1234567890');
		expect(tweetIdFromUrl('https://twitter.com/examplefox/status/1234567890?s=21')).toBe('1234567890');
		expect(tweetIdFromUrl('https://x.com/examplefox/status/1234567890/photo/1')).toBe('1234567890');
		expect(tweetIdFromUrl('https://x.com/i/status/1234567890')).toBe('1234567890');
		expect(tweetIdFromUrl('https://x.com/i/web/status/1234567890')).toBe('1234567890');
		expect(tweetIdFromUrl('https://mobile.twitter.com/examplefox/statuses/1234567890')).toBe('1234567890');
	});

	it('returns null for anything else', () => {
		expect(tweetIdFromUrl('https://x.com/examplefox')).toBeNull();
		expect(tweetIdFromUrl('https://x.com/examplefox/status/abc')).toBeNull();
		expect(tweetIdFromUrl('https://bsky.app/profile/a/post/3abc')).toBeNull();
		expect(tweetIdFromUrl('')).toBeNull();
	});
});

describe('parseTweetPhotoUrl', () => {
	it('upgrades the first photo to the largest variant', () => {
		expect(parseTweetPhotoUrl(tweetWith([photo]))).toBe(
			'https://pbs.twimg.com/media/AbCdEf123?format=jpg&name=4096x4096'
		);
	});

	it('skips video and animated gif entries', () => {
		expect(parseTweetPhotoUrl(tweetWith([{ type: 'video', media_url_https: 'https://pbs.twimg.com/x.jpg' }]))).toBeNull();
		expect(
			parseTweetPhotoUrl(tweetWith([{ type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/y.jpg' }]))
		).toBeNull();
		expect(
			parseTweetPhotoUrl(tweetWith([{ type: 'video', media_url_https: 'https://pbs.twimg.com/x.jpg' }, photo]))
		).toContain('format=jpg');
	});

	it('reads a tweet nested behind a visibility result', () => {
		expect(
			parseTweetPhotoUrl({
				data: {
					tweetResult: {
						result: {
							__typename: 'TweetWithVisibilityResults',
							tweet: { legacy: { extended_entities: { media: [photo] } } }
						}
					}
				}
			})
		).toContain('AbCdEf123');
	});

	it('falls back to entities.media when extended_entities is absent', () => {
		expect(
			parseTweetPhotoUrl({
				data: { tweetResult: { result: { legacy: { entities: { media: [photo] } } } } }
			})
		).toContain('AbCdEf123');
	});

	it('returns null on a text-only tweet, a tombstone, and junk', () => {
		expect(parseTweetPhotoUrl(tweetWith([]))).toBeNull();
		expect(parseTweetPhotoUrl({ data: { tweetResult: {} } })).toBeNull();
		expect(parseTweetPhotoUrl(null)).toBeNull();
	});
});

describe('fetchTweetMediaUrl', () => {
	const url = 'https://x.com/examplefox/status/1234567890';

	const stub = (lookup: (n: number) => Response) => {
		let lookups = 0;
		const activations = { count: 0 };
		const fetchImpl = vi.fn(async (target: string | URL | Request) => {
			if (String(target).includes('guest/activate')) {
				activations.count++;
				return json({ guest_token: `gt-${activations.count}` });
			}
			return lookup(++lookups);
		});
		return { fetchImpl, activations };
	};

	it('activates a guest token and resolves the first photo', async () => {
		const { fetchImpl } = stub(() => json(tweetWith([photo])));
		expect(await fetchTweetMediaUrl(url, fetchImpl)).toBe(
			'https://pbs.twimg.com/media/AbCdEf123?format=jpg&name=4096x4096'
		);
	});

	it('retries once with a fresh token on 401', async () => {
		const { fetchImpl, activations } = stub((n) =>
			n === 1 ? new Response('nope', { status: 401 }) : json(tweetWith([photo]))
		);
		expect(await fetchTweetMediaUrl(url, fetchImpl)).toContain('AbCdEf123');
		expect(activations.count).toBe(2);
	});

	it('returns null without fetching when the URL has no tweet id', async () => {
		const fetchImpl = vi.fn(async () => json(tweetWith([photo])));
		expect(await fetchTweetMediaUrl('https://x.com/examplefox', fetchImpl)).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('fails soft on refusal, a photoless tweet, malformed JSON, and network errors', async () => {
		expect(await fetchTweetMediaUrl(url, stub(() => new Response('no', { status: 403 })).fetchImpl)).toBeNull();
		expect(await fetchTweetMediaUrl(url, stub(() => json(tweetWith([]))).fetchImpl)).toBeNull();
		expect(await fetchTweetMediaUrl(url, stub(() => new Response('<html>')).fetchImpl)).toBeNull();
		expect(
			await fetchTweetMediaUrl(
				url,
				vi.fn(async () => {
					throw new Error('TimeoutError');
				})
			)
		).toBeNull();
	});

	it('returns null when the guest token cannot be activated', async () => {
		const fetchImpl = vi.fn(async () => new Response('blocked', { status: 403 }));
		expect(await fetchTweetMediaUrl(url, fetchImpl)).toBeNull();
	});
});
