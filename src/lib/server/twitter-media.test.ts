import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTweetMediaUrl, parseTweetPhotoUrl } from './twitter-media';

afterEach(() => {
	vi.restoreAllMocks();
});

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

describe('parseTweetPhotoUrl', () => {
	it('upgrades the first photo to the largest variant', () => {
		expect(parseTweetPhotoUrl(tweetWith([photo]))).toBe(
			'https://pbs.twimg.com/media/AbCdEf123?format=jpg&name=4096x4096'
		);
	});

	it('passes a media URL with no extension through untouched', () => {
		expect(
			parseTweetPhotoUrl(tweetWith([{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/NoExt' }]))
		).toBe('https://pbs.twimg.com/media/NoExt');
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
	const id = '1234567890';
	const unavailable = { ok: false, reason: 'unavailable' };

	const stub = (lookup: (n: number) => Response) => {
		let lookups = 0;
		const activations = { count: 0 };
		const fetchImpl = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
			if (String(target).includes('guest/activate')) {
				activations.count++;
				return json({ guest_token: `gt-${activations.count}` });
			}
			tokens.push(String(new Headers(init?.headers).get('x-guest-token')));
			return lookup(++lookups);
		});
		const tokens: string[] = [];
		return { fetchImpl, activations, tokens };
	};

	it('activates a guest token and resolves the first photo', async () => {
		const { fetchImpl, tokens } = stub(() => json(tweetWith([photo])));
		expect(await fetchTweetMediaUrl(id, fetchImpl)).toEqual({
			ok: true,
			url: 'https://pbs.twimg.com/media/AbCdEf123?format=jpg&name=4096x4096'
		});
		expect(tokens).toEqual(['gt-1']);
		const lookup = String(fetchImpl.mock.calls.find(([t]) => !String(t).includes('guest/activate'))?.[0]);
		expect(lookup).toContain(encodeURIComponent(`"tweetId":"${id}"`));
	});

	it('retries once with a fresh token on 401', async () => {
		const { fetchImpl, activations, tokens } = stub((n) =>
			n === 1 ? new Response('nope', { status: 401 }) : json(tweetWith([photo]))
		);
		const outcome = await fetchTweetMediaUrl(id, fetchImpl);
		expect(outcome.ok && outcome.url).toContain('AbCdEf123');
		expect(activations.count).toBe(2);
		expect(tokens).toEqual(['gt-1', 'gt-2']);
	});

	it('retries once with a fresh token on 429', async () => {
		const { fetchImpl, activations, tokens } = stub((n) =>
			n === 1 ? new Response('slow down', { status: 429 }) : json(tweetWith([photo]))
		);
		const outcome = await fetchTweetMediaUrl(id, fetchImpl);
		expect(outcome.ok && outcome.url).toContain('AbCdEf123');
		expect(activations.count).toBe(2);
		expect(tokens).toEqual(['gt-1', 'gt-2']);
	});

	it('reports a rate limit that survives the retry', async () => {
		const { fetchImpl, activations } = stub(() => new Response('slow down', { status: 429 }));
		expect(await fetchTweetMediaUrl(id, fetchImpl)).toEqual({ ok: false, reason: 'rate_limited' });
		expect(activations.count).toBe(2);
	});

	it('is unavailable after a 401 that survives the retry', async () => {
		const { fetchImpl } = stub(() => new Response('nope', { status: 401 }));
		expect(await fetchTweetMediaUrl(id, fetchImpl)).toEqual(unavailable);
	});

	it('fails soft on refusal, a photoless tweet, malformed JSON, and network errors', async () => {
		expect(await fetchTweetMediaUrl(id, stub(() => new Response('no', { status: 403 })).fetchImpl)).toEqual(
			unavailable
		);
		expect(await fetchTweetMediaUrl(id, stub(() => json(tweetWith([]))).fetchImpl)).toEqual(unavailable);
		expect(await fetchTweetMediaUrl(id, stub(() => new Response('<html>')).fetchImpl)).toEqual(unavailable);
		expect(
			await fetchTweetMediaUrl(
				id,
				vi.fn(async () => {
					throw new Error('TimeoutError');
				})
			)
		).toEqual(unavailable);
	});

	it('logs a malformed body as a parse failure without quoting it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await fetchTweetMediaUrl(id, stub(() => new Response('<html>secret-body')).fetchImpl);
		const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(logged).toContain('SyntaxError');
		expect(logged).not.toContain('secret-body');
	});

	it('is unavailable when the guest token cannot be activated', async () => {
		const fetchImpl = vi.fn(async () => new Response('blocked', { status: 403 }));
		expect(await fetchTweetMediaUrl(id, fetchImpl)).toEqual(unavailable);
	});
});
