import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	MAX_SUGGESTED_TAGS,
	classifySourceUrl,
	classifyMediaUrl,
	lookupBlueskyPost,
	suggestionsFromResult,
	translateTag
} from './entail';

afterEach(() => {
	vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('classifySourceUrl', () => {
	it('accepts the bluesky post shapes', () => {
		expect(classifySourceUrl('https://bsky.app/profile/example.bsky.social/post/3abc')).toEqual({
			kind: 'bluesky',
			url: 'https://bsky.app/profile/example.bsky.social/post/3abc'
		});
		expect(classifySourceUrl('https://www.bsky.app/profile/did:plc:aaaa/post/3abc/')).toEqual({
			kind: 'bluesky',
			url: 'https://bsky.app/profile/did:plc:aaaa/post/3abc'
		});
		expect(classifySourceUrl('https://bsky.app/profile/did%3Aplc%3Aaaaa/post/3abc?ref=x')).toEqual({
			kind: 'bluesky',
			url: 'https://bsky.app/profile/did:plc:aaaa/post/3abc'
		});
	});

	it('rejects a malformed or slash-smuggling percent-encoded bluesky actor', () => {
		// A bad percent sequence used to throw URIError out of the classifier.
		expect(classifySourceUrl('https://bsky.app/profile/100%/post/3abc')).toBeNull();
		// An encoded slash passes the raw-actor regex but decodes into a path
		// separator inside the canonical URL.
		expect(classifySourceUrl('https://bsky.app/profile/a%2f..%2fx/post/3abc')).toBeNull();
	});

	it('accepts the x/twitter status shapes and canonicalises them', () => {
		const canonical = { kind: 'x', url: 'https://x.com/examplefox/status/1234567890', id: '1234567890' };
		expect(classifySourceUrl('https://x.com/examplefox/status/1234567890')).toEqual(canonical);
		expect(classifySourceUrl('https://twitter.com/examplefox/status/1234567890?s=21')).toEqual(canonical);
		expect(classifySourceUrl('https://x.com/examplefox/status/1234567890/photo/1')).toEqual(canonical);
		expect(classifySourceUrl('https://mobile.twitter.com/examplefox/statuses/1234567890')).toEqual(
			canonical
		);
		expect(classifySourceUrl('https://mobile.x.com/examplefox/status/1234567890')).toEqual(canonical);
		expect(classifySourceUrl('https://x.com/i/status/1234567890')).toEqual({
			kind: 'x',
			url: 'https://x.com/i/status/1234567890',
			id: '1234567890'
		});
	});

	it('rejects anything else', () => {
		expect(classifySourceUrl('https://bsky.app/profile/example.bsky.social')).toBeNull();
		expect(classifySourceUrl('https://bsky.app/profile/example/feed/3abc')).toBeNull();
		expect(classifySourceUrl('https://x.com/examplefox')).toBeNull();
		expect(classifySourceUrl('https://x.com/examplefox/status/notanid')).toBeNull();
		expect(classifySourceUrl('https://example.com/x.com/user/status/1')).toBeNull();
		expect(classifySourceUrl('https://pbs.twimg.com/media/abc.jpg')).toBeNull();
		expect(classifySourceUrl('javascript:alert(1)')).toBeNull();
		expect(classifySourceUrl('not a url')).toBeNull();
	});
});

describe('translateTag', () => {
	it('drops the trailing qualifier and hyphenates', () => {
		expect(translateTag('digital_media_(artwork)')).toBe('digital-media');
		expect(translateTag('two_tone_fur')).toBe('two-tone-fur');
		expect(translateTag('Mammal')).toBe('mammal');
	});

	it('leaves an inner parenthetical alone', () => {
		expect(translateTag('a_(b)_c')).toBe('a-b-c');
	});

	it('runs the result through the tag sanitizer', () => {
		expect(translateTag('50%_fur')).toBe('50-fur');
		expect(translateTag('  Pink_Hair  ')).toBe('pink-hair');
	});

	it('returns null when nothing survives', () => {
		expect(translateTag('(artwork)')).toBeNull();
		expect(translateTag('!!!')).toBeNull();
		expect(translateTag('')).toBeNull();
	});
});

describe('suggestionsFromResult', () => {
	it('keeps tags at or above the floor, in confidence order', () => {
		expect(
			suggestionsFromResult({
				rating: 'safe',
				tags: [
					{ name: 'mammal', confidence: 0.92 },
					{ name: 'pink_hair', confidence: 0.8 },
					{ name: 'canine', confidence: 0.79 }
				]
			})
		).toEqual({ tags: ['mammal', 'pink-hair'], rating: 'safe' });
	});

	it('honours a custom floor', () => {
		expect(
			suggestionsFromResult({ tags: [{ name: 'canine', confidence: 0.5 }] }, 0.4).tags
		).toEqual(['canine']);
	});

	it('dedupes tags that translate to the same name', () => {
		expect(
			suggestionsFromResult({
				tags: [
					{ name: 'digital_media_(artwork)', confidence: 0.95 },
					{ name: 'digital media', confidence: 0.9 }
				]
			}).tags
		).toEqual(['digital-media']);
	});

	it('caps the list after dedupe', () => {
		const tags = Array.from({ length: MAX_SUGGESTED_TAGS + 5 }, (_, i) => ({
			name: `tag_${i}`,
			confidence: 0.99
		}));
		// A duplicate ahead of the cap must not count against it.
		tags.unshift({ name: 'tag_0', confidence: 0.999 });
		const result = suggestionsFromResult({ tags }).tags;
		expect(result).toHaveLength(MAX_SUGGESTED_TAGS);
		expect(result[0]).toBe('tag-0');
		expect(new Set(result).size).toBe(MAX_SUGGESTED_TAGS);
	});

	it('drops junk entries and unknown ratings', () => {
		expect(
			suggestionsFromResult({
				rating: 'nsfw',
				tags: [{ name: 42 }, { confidence: 0.99 }, { name: '(artwork)', confidence: 0.99 }]
			})
		).toEqual({ tags: [], rating: null });
		expect(suggestionsFromResult(null)).toEqual({ tags: [], rating: null });
		expect(suggestionsFromResult({ tags: 'nope' })).toEqual({ tags: [], rating: null });
	});
});

describe('lookupBlueskyPost', () => {
	const url = 'https://bsky.app/profile/did:plc:aaaa/post/3abc';
	const post = {
		uri: 'at://did:plc:aaaa/app.bsky.feed.post/3abc',
		images: [
			{ cid: 'one', rating: 'explicit', tags: [{ name: 'mammal', confidence: 0.99 }] },
			{ cid: 'two', rating: 'safe', tags: [{ name: 'canine', confidence: 0.99 }] }
		]
	};

	it('uses the first image only, and reports how many there were', async () => {
		const fetchImpl = vi.fn(async (_url: string | URL | Request) => json(post));
		expect(await lookupBlueskyPost(url, fetchImpl)).toEqual({
			ok: true,
			suggestions: { tags: ['mammal'], rating: 'explicit' },
			imageCount: 2
		});
		const requested = String(fetchImpl.mock.calls[0]?.[0]);
		expect(requested).toContain('min_confidence=0.8');
		expect(requested).toContain('wait=true');
	});

	it('fails without fetching for a non-bluesky URL', async () => {
		const fetchImpl = vi.fn(async () => json(post));
		expect(await lookupBlueskyPost('https://x.com/examplefox/status/1', fetchImpl)).toEqual({
			ok: false,
			reason: 'unavailable'
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('names the reason a lookup produced nothing', async () => {
		expect(await lookupBlueskyPost(url, vi.fn(async () => json({}, 202)))).toEqual({
			ok: false,
			reason: 'not_ready'
		});
		expect(
			await lookupBlueskyPost(url, vi.fn(async () => new Response('slow down', { status: 429 })))
		).toEqual({ ok: false, reason: 'rate_limited' });
		expect(
			await lookupBlueskyPost(url, vi.fn(async () => new Response('boom', { status: 500 })))
		).toEqual({ ok: false, reason: 'unavailable' });
		expect(
			await lookupBlueskyPost(
				url,
				vi.fn(async () => {
					throw new Error('TimeoutError');
				})
			)
		).toEqual({ ok: false, reason: 'unavailable' });
	});

	it('logs a malformed body as a parse failure without quoting it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(
			await lookupBlueskyPost(url, vi.fn(async () => new Response('<html>secret-body', { status: 200 })))
		).toEqual({ ok: false, reason: 'unavailable' });
		const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(logged).toContain('SyntaxError');
		expect(logged).not.toContain('secret-body');
		expect(logged).not.toContain('<html>');
	});

	it('ignores a bare-array body the API never sends', async () => {
		expect(await lookupBlueskyPost(url, vi.fn(async () => json(post.images)))).toEqual({
			ok: true,
			suggestions: { tags: [], rating: null },
			imageCount: 0
		});
	});

	it('succeeds with no tags when the post has no classified images', async () => {
		const fetchImpl = vi.fn(async () => json({ uri: 'at://x', images: [] }));
		expect(await lookupBlueskyPost(url, fetchImpl)).toEqual({
			ok: true,
			suggestions: { tags: [], rating: null },
			imageCount: 0
		});
	});
});

describe('classifyMediaUrl', () => {
	const url = 'https://pbs.twimg.com/media/abc';
	const done = {
		status: 'done',
		content_sha256: 'abc',
		rating: 'questionable',
		tags: [{ name: 'mammal', confidence: 0.99 }]
	};
	const success = {
		ok: true,
		suggestions: { tags: ['mammal'], rating: 'questionable' },
		imageCount: 1
	};

	it('refuses a host outside the allowlist without fetching', async () => {
		const fetchImpl = vi.fn(async () => json(done));
		const refused = { ok: false, reason: 'unavailable' };
		expect(await classifyMediaUrl('https://example.com/a.jpg', fetchImpl)).toEqual(refused);
		expect(await classifyMediaUrl('https://evil.pbs.twimg.com/a.jpg', fetchImpl)).toEqual(refused);
		expect(await classifyMediaUrl('http://pbs.twimg.com/a.jpg', fetchImpl)).toEqual(refused);
		expect(await classifyMediaUrl('nonsense', fetchImpl)).toEqual(refused);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('enqueues then polls until the job is done', async () => {
		let polls = 0;
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'POST') return json({ job_id: 'job-1', status: 'enqueued' }, 202);
			polls++;
			expect(String(url)).toContain('/classify/job-1?wait=true');
			return polls === 1 ? json({ status: 'processing' }, 202) : json(done);
		});
		expect(await classifyMediaUrl('https://pbs.twimg.com/media/abc?format=jpg', fetchImpl)).toEqual(
			success
		);
		expect(polls).toBe(2);
	});

	it('accepts cdn.bsky.app too', async () => {
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
			init?.method === 'POST' ? json({ job_id: 'job-2' }, 202) : json(done)
		);
		expect(await classifyMediaUrl('https://cdn.bsky.app/img/feed_fullsize/x.jpg', fetchImpl)).toEqual(
			success
		);
	});

	it('gives up after the poll cap', async () => {
		let polls = 0;
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'POST') return json({ job_id: 'job-3' }, 202);
			polls++;
			return json({ status: 'processing' }, 202);
		});
		expect(await classifyMediaUrl(url, fetchImpl)).toEqual({ ok: false, reason: 'unavailable' });
		expect(polls).toBe(2);
	});

	// The poll endpoint answers `wait=true` by holding the connection until the
	// classifier finishes — about five seconds for a fresh job. A poll timeout
	// shorter than that hold aborts the response we asked to wait for, which is
	// what a 2000 ms timeout did in the first cut of this module.
	it('waits out a poll that the server holds open for seconds', async () => {
		const heldFor = 2500;
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'POST') return json({ job_id: 'job-5' }, 202);
			await new Promise((resolve) => setTimeout(resolve, heldFor));
			init?.signal?.throwIfAborted();
			return json(done);
		});
		expect(await classifyMediaUrl(url, fetchImpl)).toEqual(success);
	}, 10_000);

	it('is unavailable on a failed enqueue, a missing job id, and errors', async () => {
		const unavailable = { ok: false, reason: 'unavailable' };
		expect(
			await classifyMediaUrl(url, vi.fn(async () => new Response('boom', { status: 500 })))
		).toEqual(unavailable);
		expect(await classifyMediaUrl(url, vi.fn(async () => json({ status: 'enqueued' }, 202)))).toEqual(
			unavailable
		);
		// The spec documents `job_id` only; a bare `id` is not a job id.
		expect(await classifyMediaUrl(url, vi.fn(async () => json({ id: 'job-7' }, 202)))).toEqual(
			unavailable
		);
		expect(
			await classifyMediaUrl(
				url,
				vi.fn(async () => {
					throw new Error('TimeoutError');
				})
			)
		).toEqual(unavailable);
	});

	it('logs a malformed poll body as a parse failure without quoting it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
			init?.method === 'POST' ? json({ job_id: 'job-8' }, 202) : new Response('<html>secret-body')
		);
		expect(await classifyMediaUrl(url, fetchImpl)).toEqual({ ok: false, reason: 'unavailable' });
		const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
		expect(logged).toContain('SyntaxError');
		expect(logged).not.toContain('secret-body');
	});

	it('names a rate limit from either the enqueue or a poll', async () => {
		expect(
			await classifyMediaUrl(url, vi.fn(async () => new Response('slow down', { status: 429 })))
		).toEqual({ ok: false, reason: 'rate_limited' });

		const limitedPoll = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
			init?.method === 'POST'
				? json({ job_id: 'job-6' }, 202)
				: new Response('slow down', { status: 429 })
		);
		expect(await classifyMediaUrl(url, limitedPoll)).toEqual({
			ok: false,
			reason: 'rate_limited'
		});
	});

	it('is unavailable when a poll fails outright', async () => {
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
			init?.method === 'POST'
				? json({ job_id: 'job-4' }, 202)
				: new Response('gone', { status: 404 })
		);
		expect(await classifyMediaUrl(url, fetchImpl)).toEqual({ ok: false, reason: 'unavailable' });
	});
});
