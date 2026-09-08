import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTweetMediaUrl, parseTweetPhotos } from './twitter-media';

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
/** What parseTweetPhotos reports for a tweet that resolved without a photo. */
const noPhoto = { url: null, photoCount: 0 };

describe('parseTweetPhotos', () => {
	it('upgrades the first photo to the largest variant', () => {
		expect(parseTweetPhotos(tweetWith([photo]))).toEqual({
			url: 'https://pbs.twimg.com/media/AbCdEf123?format=jpg&name=4096x4096',
			photoCount: 1
		});
	});

	it('counts every photo but resolves only the first', () => {
		const second = { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/Second.png' };
		const third = { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/Third.png' };
		expect(parseTweetPhotos(tweetWith([photo, second, third]))).toEqual({
			url: 'https://pbs.twimg.com/media/AbCdEf123?format=jpg&name=4096x4096',
			photoCount: 3
		});
	});

	it('clamps the photo count to the four X allows', () => {
		// X attaches at most four photos; a body claiming more is not trusted.
		const six = Array.from({ length: 6 }, (_, i) => ({
			type: 'photo',
			media_url_https: `https://pbs.twimg.com/media/P${i}.jpg`
		}));
		expect(parseTweetPhotos(tweetWith(six))?.photoCount).toBe(4);
		expect(parseTweetPhotos(tweetWith(six.slice(0, 4)))?.photoCount).toBe(4);
	});

	it('passes a media URL with no extension through untouched', () => {
		expect(
			parseTweetPhotos(tweetWith([{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/NoExt' }]))
				?.url
		).toBe('https://pbs.twimg.com/media/NoExt');
	});

	it('skips video and animated gif entries', () => {
		expect(parseTweetPhotos(tweetWith([{ type: 'video', media_url_https: 'https://pbs.twimg.com/x.jpg' }]))).toEqual(
			noPhoto
		);
		expect(
			parseTweetPhotos(tweetWith([{ type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/y.jpg' }]))
		).toEqual(noPhoto);
		// A video alongside a photo is not counted as a photo, and the photo, not
		// the video's poster, is what resolves.
		expect(
			parseTweetPhotos(tweetWith([{ type: 'video', media_url_https: 'https://pbs.twimg.com/x.jpg' }, photo]))
		).toEqual({ url: 'https://pbs.twimg.com/media/AbCdEf123?format=jpg&name=4096x4096', photoCount: 1 });
	});

	it('reads a tweet nested behind a visibility result', () => {
		expect(
			parseTweetPhotos({
				data: {
					tweetResult: {
						result: {
							__typename: 'TweetWithVisibilityResults',
							tweet: { legacy: { extended_entities: { media: [photo] } } }
						}
					}
				}
			})?.url
		).toContain('AbCdEf123');
	});

	it('ignores entities.media, which cannot tell a video poster from a photo', () => {
		// Only extended_entities carries the real media type; entities.media
		// types a video's poster frame as a photo, so it is never read, and a
		// tweet with nothing else is a tweet with no photo.
		expect(
			parseTweetPhotos({
				data: { tweetResult: { result: { legacy: { entities: { media: [photo] } } } } }
			})
		).toEqual(noPhoto);
	});

	it('reports no photo on a text-only tweet', () => {
		expect(parseTweetPhotos(tweetWith([]))).toEqual(noPhoto);
		expect(parseTweetPhotos({ data: { tweetResult: { result: { legacy: {} } } } })).toEqual(noPhoto);
	});

	it('returns null on a tombstone and junk', () => {
		expect(parseTweetPhotos({ data: { tweetResult: { result: { __typename: 'TweetTombstone' } } } })).toBeNull();
		expect(parseTweetPhotos({ data: { tweetResult: {} } })).toBeNull();
		expect(parseTweetPhotos(null)).toBeNull();
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
			url: 'https://pbs.twimg.com/media/AbCdEf123?format=jpg&name=4096x4096',
			photoCount: 1
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

	it('returns unavailable without fetching when the deadline has already passed', async () => {
		const { fetchImpl } = stub(() => json(tweetWith([photo])));
		expect(await fetchTweetMediaUrl(id, fetchImpl, AbortSignal.abort())).toEqual(unavailable);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('reports a rate limit that survives the retry', async () => {
		const { fetchImpl, activations } = stub(() => new Response('slow down', { status: 429 }));
		expect(await fetchTweetMediaUrl(id, fetchImpl)).toEqual({ ok: false, reason: 'rate_limited' });
		expect(activations.count).toBe(2);
	});

	it('stays rate_limited when the retry cannot even get a fresh token after a 429', async () => {
		let activations = 0;
		const fetchImpl = vi.fn(async (target: string | URL | Request) => {
			if (String(target).includes('guest/activate')) {
				activations++;
				return activations === 1 ? json({ guest_token: 'gt-1' }) : new Response('slow down', { status: 429 });
			}
			return new Response('slow down', { status: 429 });
		});
		expect(await fetchTweetMediaUrl(id, fetchImpl)).toEqual({ ok: false, reason: 'rate_limited' });
		expect(activations).toBe(2);
	});

	it('is unavailable after a 401 that survives the retry', async () => {
		const { fetchImpl } = stub(() => new Response('nope', { status: 401 }));
		expect(await fetchTweetMediaUrl(id, fetchImpl)).toEqual(unavailable);
	});

	it('resolves a photoless tweet as ok with no URL, not as an outage', async () => {
		// A text, video or GIF tweet is a real answer; the endpoint turns it into
		// "no tags" rather than an unavailable classifier.
		expect(await fetchTweetMediaUrl(id, stub(() => json(tweetWith([]))).fetchImpl)).toEqual({
			ok: true,
			url: null,
			photoCount: 0
		});
	});

	it('reports a tweet the guest token cannot read as not_found, not an outage', async () => {
		// Deleted, protected, or a tombstone: X answers 200 with no tweet in it.
		// That is the operator's input, so the endpoint answers 404, not 502.
		const notFound = { ok: false, reason: 'not_found' };
		expect(
			await fetchTweetMediaUrl(
				id,
				stub(() => json({ data: { tweetResult: { result: { __typename: 'TweetTombstone' } } } })).fetchImpl
			)
		).toEqual(notFound);
		expect(await fetchTweetMediaUrl(id, stub(() => json({ data: { tweetResult: {} } })).fetchImpl)).toEqual(
			notFound
		);
	});

	it('reports a 200 that carries an errors array as unavailable, not not_found', async () => {
		// A rotated query id or features map: X answers 200 with `errors` and no
		// tweet. That is the integration, not the operator's post, so 502 not 404.
		const errors = [{ message: 'Query not found', code: 42 }];
		expect(await fetchTweetMediaUrl(id, stub(() => json({ errors })).fetchImpl)).toEqual(unavailable);
		expect(
			await fetchTweetMediaUrl(id, stub(() => json({ errors, data: { tweetResult: {} } })).fetchImpl)
		).toEqual(unavailable);
		// An empty errors array carries no error: still the not_found path.
		expect(
			await fetchTweetMediaUrl(id, stub(() => json({ errors: [], data: { tweetResult: {} } })).fetchImpl)
		).toEqual({ ok: false, reason: 'not_found' });
	});

	it('fails soft on refusal, a server error, malformed JSON, and network errors', async () => {
		expect(await fetchTweetMediaUrl(id, stub(() => new Response('no', { status: 403 })).fetchImpl)).toEqual(
			unavailable
		);
		expect(await fetchTweetMediaUrl(id, stub(() => new Response('boom', { status: 500 })).fetchImpl)).toEqual(
			unavailable
		);
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

	it('is unavailable when the guest token cannot be activated', async () => {
		const fetchImpl = vi.fn(async () => new Response('blocked', { status: 403 }));
		expect(await fetchTweetMediaUrl(id, fetchImpl)).toEqual(unavailable);
	});
});
