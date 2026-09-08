import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	MAX_RAW_ENTRIES,
	MAX_SUGGESTED_TAGS,
	POLL_TIMEOUT_MS,
	POST_TIMEOUT_MS,
	classifySourceUrl,
	classifyMediaUrl,
	lookupBlueskySource,
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
		// A double-encoded actor decodes to one that still carries a `%`; the
		// endpoint used to decode that again downstream.
		expect(classifySourceUrl('https://bsky.app/profile/a%252Fb/post/3abc')).toBeNull();
		expect(classifySourceUrl('https://bsky.app/profile/foo%252ebar/post/3abc')).toBeNull();
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
		// The share-sheet permalink form.
		expect(classifySourceUrl('https://x.com/i/web/status/1234567890')).toEqual({
			kind: 'x',
			url: 'https://x.com/i/status/1234567890',
			id: '1234567890'
		});
		expect(classifySourceUrl('https://twitter.com/i/web/status/1234567890?s=20')).toEqual({
			kind: 'x',
			url: 'https://x.com/i/status/1234567890',
			id: '1234567890'
		});
		// `web` only means something after `i`.
		expect(classifySourceUrl('https://x.com/web/status/1234567890')).toEqual({
			kind: 'x',
			url: 'https://x.com/web/status/1234567890',
			id: '1234567890'
		});
		expect(classifySourceUrl('https://x.com/i/web/1234567890')).toBeNull();
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

	it('leaves no doubled or trailing hyphen when the cap cuts a hyphen run', () => {
		// The sanitizer slices at 50 characters. A run of hyphens straddling the
		// cut would otherwise survive as a doubled or trailing hyphen.
		const tag = translateTag(`${'a'.repeat(48)}___bbb`);
		expect(tag).toBe('a'.repeat(48));
		expect(tag).not.toMatch(/--|-$/);
	});

	it('drops emoticon tags instead of leaving their debris', () => {
		// e621 carries symbol-only tags whose sanitized remains ("3", "-", "---")
		// would otherwise be suggested as if they were words.
		expect(translateTag('<3')).toBeNull();
		expect(translateTag('^_^')).toBeNull();
		expect(translateTag('-_-')).toBeNull();
		expect(translateTag(':3')).toBeNull();
		expect(translateTag('digital_media_(artwork)')).toBe('digital-media');
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

	it('stops reading a hostile tag array after the entry cap', () => {
		const low = { name: 'noise', confidence: 0.1 };
		const tags = Array.from({ length: MAX_RAW_ENTRIES + 1 }, () => ({ ...low }));
		// The last entry inside the cap is read; the first one past it is not.
		tags[MAX_RAW_ENTRIES - 1] = { name: 'canine', confidence: 0.99 };
		tags[MAX_RAW_ENTRIES] = { name: 'mammal', confidence: 0.99 };
		expect(suggestionsFromResult({ tags }).tags).toEqual(['canine']);
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

describe('timeouts', () => {
	it('outlast the wait=true hold the server puts on a fresh job', () => {
		// About five seconds measured on 2026-09-07; anything at or above six
		// clears it. The comment above the constants explains why this matters.
		expect(POST_TIMEOUT_MS).toBeGreaterThanOrEqual(6000);
		expect(POLL_TIMEOUT_MS).toBeGreaterThanOrEqual(6000);
	});
});

describe('lookupBlueskySource', () => {
	const url = 'https://bsky.app/profile/did:plc:aaaa/post/3abc';
	// The endpoint validates the URL with classifySourceUrl and hands the
	// result straight to lookupBlueskySource; this does the same in one step.
	const lookupBlueskyPost = (postUrl: string, fetchImpl: typeof fetch, signal?: AbortSignal) => {
		const source = classifySourceUrl(postUrl);
		if (!source || source.kind !== 'bluesky') throw new Error(`not a bluesky post: ${postUrl}`);
		return lookupBlueskySource(source, fetchImpl, signal);
	};
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

	it('sends a validated source as-is through lookupBlueskySource', async () => {
		const fetchImpl = vi.fn(async (_url: string | URL | Request) => json(post));
		const source = { kind: 'bluesky' as const, url: 'https://bsky.app/profile/did:plc:aaaa/post/3abc' };
		expect((await lookupBlueskySource(source, fetchImpl)).ok).toBe(true);
		expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(encodeURIComponent(source.url));
	});

	it('returns unavailable without fetching when the deadline has already passed', async () => {
		const fetchImpl = vi.fn(async () => json(post));
		const source = { kind: 'bluesky' as const, url };
		expect(await lookupBlueskySource(source, fetchImpl, AbortSignal.abort())).toEqual({
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

	it('is unavailable on a 200 whose body has no images array', async () => {
		// A bare array, or an object missing `images`, is a shape we don't know.
		// It must not pass as "the classifier found nothing" (which is `images: []`).
		const unavailable = { ok: false, reason: 'unavailable' };
		expect(await lookupBlueskyPost(url, vi.fn(async () => json(post.images)))).toEqual(unavailable);
		expect(await lookupBlueskyPost(url, vi.fn(async () => json({ uri: 'at://x' })))).toEqual(
			unavailable
		);
	});

	it('succeeds with no tags when the post has no classified images', async () => {
		const fetchImpl = vi.fn(async () => json({ uri: 'at://x', images: [] }));
		expect(await lookupBlueskyPost(url, fetchImpl)).toEqual({
			ok: true,
			suggestions: { tags: [], rating: null },
			imageCount: 0
		});
	});

	// `/post?wait=true` holds the connection open while the classifier works,
	// the same way the classify poll does (see the matching test below). A post
	// timeout shorter than that hold would abort the answer we asked to wait for.
	it('waits out a post lookup that the server holds open for seconds', async () => {
		const heldFor = 2500;
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			await new Promise((resolve) => setTimeout(resolve, heldFor));
			init?.signal?.throwIfAborted();
			return json(post);
		});
		expect(await lookupBlueskyPost(url, fetchImpl)).toEqual({
			ok: true,
			suggestions: { tags: ['mammal'], rating: 'explicit' },
			imageCount: 2
		});
	}, 10_000);
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
		const mediaUrl = 'https://pbs.twimg.com/media/abc?format=jpg';
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'POST') {
				expect(new Headers(init.headers).get('content-type')).toBe('application/json');
				expect(JSON.parse(String(init.body))).toEqual({ url: mediaUrl });
				return json({ job_id: 'job-1', status: 'enqueued' }, 202);
			}
			polls++;
			expect(String(url)).toContain('/classify/job-1?wait=true');
			return polls === 1 ? json({ status: 'processing' }, 202) : json(done);
		});
		expect(await classifyMediaUrl(mediaUrl, fetchImpl)).toEqual(success);
		expect(polls).toBe(2);
	});

	it('encodes the job id into the poll path', async () => {
		let polled = '';
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'POST') return json({ job_id: '../post' }, 202);
			polled = String(url);
			return json(done);
		});
		await classifyMediaUrl(url, fetchImpl);
		expect(polled.startsWith('https://entail.dev/api/classify/')).toBe(true);
		expect(polled).toContain('%2F');
	});

	it('accepts a 200 poll body that carries no status field', async () => {
		const { status: _status, ...bare } = done;
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
			init?.method === 'POST' ? json({ job_id: 'job-8' }, 202) : json(bare)
		);
		expect(await classifyMediaUrl(url, fetchImpl)).toEqual(success);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('returns unavailable without fetching when the deadline has already passed', async () => {
		const fetchImpl = vi.fn(async () => json(done));
		expect(await classifyMediaUrl(url, fetchImpl, AbortSignal.abort())).toEqual({
			ok: false,
			reason: 'unavailable'
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('is unavailable when the caller\'s deadline passes during a fetch', async () => {
		// The per-call timeout is joined with the caller's signal, so an abort
		// from outside reaches the in-flight fetch through init.signal.
		const controller = new AbortController();
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
				})
		);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const pending = classifyMediaUrl(url, fetchImpl, controller.signal);
		controller.abort(new Error('caller deadline'));
		expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// The caller's reason, not the per-call TimeoutError, is what ended it.
		expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('caller deadline');
	});

	it('is unavailable on a 200 poll body that is not a classification entry', async () => {
		// null, a string, or an error envelope must not read as "no tags found".
		const unavailable = { ok: false, reason: 'unavailable' };
		for (const body of [null, 'done', { detail: 'x' }]) {
			const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
				init?.method === 'POST' ? json({ job_id: 'job-9' }, 202) : json(body)
			);
			expect(await classifyMediaUrl(url, fetchImpl)).toEqual(unavailable);
		}
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
