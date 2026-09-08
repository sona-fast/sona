import { describe, it, expect, vi, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { LookupOutcome, SourceKind } from '$lib/server/entail';
import type { TweetMediaOutcome } from '$lib/server/twitter-media';
import { makeD1 } from '$lib/server/test/d1';
import { POST, _LOOKUP_DEADLINE_MS } from './+server';

// Only the outbound calls are stubbed. classifySourceUrl stays real, so the
// URL recognition the endpoint depends on is exercised rather than mocked.
const lookupBlueskySource = vi.hoisted(() =>
	vi.fn(
		async (_source: SourceKind, _fetch?: typeof fetch, _signal?: AbortSignal): Promise<LookupOutcome> => ({
			ok: false,
			reason: 'unavailable'
		})
	)
);
const classifyMediaUrl = vi.hoisted(() =>
	vi.fn(
		async (_url: string, _fetch?: typeof fetch, _signal?: AbortSignal): Promise<LookupOutcome> => ({
			ok: false,
			reason: 'unavailable'
		})
	)
);
const fetchTweetMediaUrl = vi.hoisted(() =>
	vi.fn(
		async (_id: string, _fetch?: typeof fetch, _signal?: AbortSignal): Promise<TweetMediaOutcome> => ({
			ok: false,
			reason: 'unavailable'
		})
	)
);

vi.mock('$lib/server/entail', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/entail')>();
	return { ...original, lookupBlueskySource, classifyMediaUrl };
});
vi.mock('$lib/server/twitter-media', () => ({ fetchTweetMediaUrl }));

const DDL = `CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT,
	image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER, file_size INTEGER,
	md5hash TEXT, nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
	source_post_url TEXT, artist_id INTEGER, collection_id INTEGER, commissioned_at TEXT,
	parent_image_id INTEGER, variant_label TEXT, featured INTEGER NOT NULL DEFAULT 0,
	featured_order INTEGER, created_at TEXT);`;

const BSKY_POST = 'https://bsky.app/profile/example.bsky.social/post/3abc';
const X_POST = 'https://x.com/examplefox/status/1234567890';
const X_ID = '1234567890';
const MEDIA_URL = 'https://pbs.twimg.com/media/AbCdEf123?format=jpg&name=4096x4096';

const suggestions: LookupOutcome = {
	ok: true,
	suggestions: { tags: ['mammal', 'pink-hair'], rating: 'safe' },
	imageCount: 3
};

function makeEnv() {
	const sqlite = new Database(':memory:');
	sqlite.exec(DDL);
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function insertImage(sqlite: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }, sourcePostUrl: string | null) {
	sqlite
		.prepare('INSERT INTO images (id, title, image_url, source_post_url) VALUES (?, ?, ?, ?)')
		.run(7, 'A picture', 'https://example.com/a.png', sourcePostUrl);
}

function event(platform: App.Platform, body: unknown, raw?: string) {
	const request = new Request('http://localhost/api/admin/tag-suggestions', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: raw ?? JSON.stringify(body)
	});
	return { request, platform } as never;
}

beforeEach(() => {
	lookupBlueskySource.mockReset();
	classifyMediaUrl.mockReset();
	fetchTweetMediaUrl.mockReset();
	lookupBlueskySource.mockResolvedValue(suggestions);
	classifyMediaUrl.mockResolvedValue(suggestions);
	fetchTweetMediaUrl.mockResolvedValue({ ok: true, url: MEDIA_URL, photoCount: 1 });
});

describe('POST /api/admin/tag-suggestions', () => {
	it('suggests tags for a bluesky source URL', async () => {
		const { platform } = makeEnv();
		const res = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			source: 'bluesky',
			tags: ['mammal', 'pink-hair'],
			rating: 'safe',
			imageCount: 3
		});
		// The validated source, not the caller's string.
		expect(lookupBlueskySource).toHaveBeenCalledWith(
			{ kind: 'bluesky', url: BSKY_POST },
			fetch,
			expect.any(AbortSignal)
		);
		expect(fetchTweetMediaUrl).not.toHaveBeenCalled();
	});

	it('resolves an X post to its media URL, then classifies that', async () => {
		const { platform } = makeEnv();
		const res = await POST(event(platform, { sourcePostUrl: `${X_POST}/photo/1` }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			source: 'x',
			tags: ['mammal', 'pink-hair'],
			rating: 'safe',
			// The tweet's photo count, not whatever classifyMediaUrl reports.
			imageCount: 1
		});
		// Only the validated status id goes to X, never the caller's string, and
		// both calls share the endpoint's one deadline.
		expect(fetchTweetMediaUrl).toHaveBeenCalledWith(X_ID, fetch, expect.any(AbortSignal));
		// The media URL is what reaches entail.dev — never the tweet URL.
		expect(classifyMediaUrl).toHaveBeenCalledWith(MEDIA_URL, fetch, expect.any(AbortSignal));
		expect(classifyMediaUrl.mock.calls[0]?.[2]).toBe(fetchTweetMediaUrl.mock.calls[0]?.[2]);
		expect(lookupBlueskySource).not.toHaveBeenCalled();
	});

	it('reports how many photos a multi-photo tweet carried', async () => {
		const { platform } = makeEnv();
		fetchTweetMediaUrl.mockResolvedValue({ ok: true, url: MEDIA_URL, photoCount: 3 });
		classifyMediaUrl.mockResolvedValue({ ...suggestions, imageCount: 1 });
		const res = await POST(event(platform, { sourcePostUrl: X_POST }));
		expect(res.status).toBe(200);
		expect((await res.json()).imageCount).toBe(3);
	});

	it('reports a null imageCount when the tweet lookup could not count', async () => {
		const { platform } = makeEnv();
		// The entities.media fallback lists one item whatever the tweet carried,
		// so the count is unknown, not 1.
		fetchTweetMediaUrl.mockResolvedValue({ ok: true, url: MEDIA_URL, photoCount: null });
		classifyMediaUrl.mockResolvedValue({ ...suggestions, imageCount: 1 });
		const res = await POST(event(platform, { sourcePostUrl: X_POST }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			source: 'x',
			tags: ['mammal', 'pink-hair'],
			rating: 'safe',
			imageCount: null
		});
	});

	it('gives the lookup chain a deadline that clears one full X round', async () => {
		// One activate (5 s) + one tweet lookup (5 s) + one enqueue (3 s) + one
		// poll (8 s) at their own timeouts is 21 s; the deadline exists to stop
		// the retry paths, not to cut that chain short of its first attempt.
		const firstAttempt = 5_000 + 5_000 + 3_000 + 8_000;
		expect(_LOOKUP_DEADLINE_MS).toBeGreaterThanOrEqual(firstAttempt);
	});

	it('refuses a declared Content-Length over the cap before reading the body', async () => {
		const { platform } = makeEnv();
		const request = new Request('http://localhost/api/admin/tag-suggestions', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': '5000' },
			body: JSON.stringify({ sourcePostUrl: BSKY_POST })
		});
		const res = await POST({ request, platform } as never);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_request' });
		expect(lookupBlueskySource).not.toHaveBeenCalled();
	});

	it('reads the stored source URL for an imageId', async () => {
		const { sqlite, platform } = makeEnv();
		insertImage(sqlite, BSKY_POST);
		const res = await POST(event(platform, { imageId: 7 }));
		expect(res.status).toBe(200);
		expect((await res.json()).source).toBe('bluesky');
		expect(lookupBlueskySource).toHaveBeenCalledWith(
			{ kind: 'bluesky', url: BSKY_POST },
			fetch,
			expect.any(AbortSignal)
		);
	});

	it('404s an unknown imageId', async () => {
		const { platform } = makeEnv();
		const res = await POST(event(platform, { imageId: 99 }));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not_found' });
		expect(lookupBlueskySource).not.toHaveBeenCalled();
	});

	it('422s a source we have no classifier for, including a stored empty one', async () => {
		const { sqlite, platform } = makeEnv();
		insertImage(sqlite, null);
		for (const body of [
			{ sourcePostUrl: 'https://furaffinity.net/view/12345/' },
			// A malformed percent sequence in the actor is unsupported, not a 500.
			{ sourcePostUrl: 'https://bsky.app/profile/100%/post/3abc' },
			// A double-encoded actor is refused up front rather than decoded a
			// second time on its way to entail.dev.
			{ sourcePostUrl: 'https://bsky.app/profile/a%252Fb/post/3abc' },
			{ sourcePostUrl: '' },
			{ imageId: 7 }
		]) {
			const res = await POST(event(platform, body));
			expect(res.status).toBe(422);
			expect(await res.json()).toEqual({ error: 'unsupported_source' });
		}
		expect(lookupBlueskySource).not.toHaveBeenCalled();
	});

	it('400s malformed and ambiguous request bodies', async () => {
		const { platform } = makeEnv();
		const bad: Array<[unknown, string | undefined]> = [
			[undefined, 'not json'],
			[undefined, '[1,2]'],
			[{}, undefined],
			[{ imageId: 7, sourcePostUrl: BSKY_POST }, undefined],
			[{ imageId: '7' }, undefined],
			[{ imageId: 1.5 }, undefined],
			[{ imageId: 0 }, undefined],
			[{ sourcePostUrl: 42 }, undefined],
			[{ sourcePostUrl: `https://bsky.app/profile/a/post/${'x'.repeat(2100)}` }, undefined],
			// Over the body cap: refused before JSON.parse ever sees it, even though
			// the URL inside is fine and the padding would otherwise be ignored.
			[undefined, JSON.stringify({ sourcePostUrl: BSKY_POST, pad: 'x'.repeat(4100) })]
		];
		for (const [body, raw] of bad) {
			const res = await POST(event(platform, body, raw));
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'invalid_request' });
		}
	});

	it('accepts a body of exactly the cap and refuses one byte more', async () => {
		const { platform } = makeEnv();
		// ASCII throughout, so characters are bytes. Pad to the cap exactly.
		const shell = JSON.stringify({ sourcePostUrl: BSKY_POST, pad: '' });
		const atCap = JSON.stringify({ sourcePostUrl: BSKY_POST, pad: 'x'.repeat(4096 - shell.length) });
		expect(new TextEncoder().encode(atCap).length).toBe(4096);
		expect((await POST(event(platform, undefined, atCap))).status).toBe(200);

		const overCap = JSON.stringify({ sourcePostUrl: BSKY_POST, pad: 'x'.repeat(4097 - shell.length) });
		expect(new TextEncoder().encode(overCap).length).toBe(4097);
		const res = await POST(event(platform, undefined, overCap));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: 'invalid_request' });
		// Multi-byte characters count as bytes, not characters: 2048 two-byte
		// characters fit in the pad's character budget but not its byte budget.
		const wide = JSON.stringify({ sourcePostUrl: BSKY_POST, pad: 'é'.repeat(2048) });
		expect((await POST(event(platform, undefined, wide))).status).toBe(400);
	});

	it('200s with no tags when the classifier found nothing to suggest', async () => {
		const { platform } = makeEnv();
		// The classifier read the post and rated it; nothing cleared the
		// confidence floor. That is an answer, not a failure.
		lookupBlueskySource.mockResolvedValue({
			ok: true,
			suggestions: { tags: [], rating: 'safe' },
			imageCount: 3
		});
		const res = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ source: 'bluesky', tags: [], rating: 'safe', imageCount: 3 });
	});

	it('passes an imageCount of 0 through as a success', async () => {
		const { platform } = makeEnv();
		// A post with no classified images: still 200, still zero, not a failure.
		lookupBlueskySource.mockResolvedValue({
			ok: true,
			suggestions: { tags: [], rating: null },
			imageCount: 0
		});
		const res = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ source: 'bluesky', tags: [], rating: null, imageCount: 0 });
	});

	it('502s not_ready when the post is queued but unclassified', async () => {
		const { platform } = makeEnv();
		lookupBlueskySource.mockResolvedValue({ ok: false, reason: 'not_ready' });
		const res = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'not_ready' });
	});

	it('502s unavailable for a failed lookup and for an unresolvable tweet', async () => {
		const { platform } = makeEnv();
		lookupBlueskySource.mockResolvedValue({ ok: false, reason: 'unavailable' });
		const bsky = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(bsky.status).toBe(502);
		expect(await bsky.json()).toEqual({ error: 'unavailable' });

		fetchTweetMediaUrl.mockResolvedValue({ ok: false, reason: 'unavailable' });
		const x = await POST(event(platform, { sourcePostUrl: X_POST }));
		expect(x.status).toBe(502);
		expect(await x.json()).toEqual({ error: 'unavailable' });
		expect(classifyMediaUrl).not.toHaveBeenCalled();
	});

	it('429s when entail.dev rate limited us', async () => {
		const { platform } = makeEnv();
		lookupBlueskySource.mockResolvedValue({ ok: false, reason: 'rate_limited' });
		const res = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: 'rate_limited' });
	});

	it('429s when X rate limited the tweet lookup', async () => {
		const { platform } = makeEnv();
		fetchTweetMediaUrl.mockResolvedValue({ ok: false, reason: 'rate_limited' });
		const res = await POST(event(platform, { sourcePostUrl: X_POST }));
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: 'rate_limited' });
		expect(classifyMediaUrl).not.toHaveBeenCalled();
	});
});
