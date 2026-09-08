import { describe, it, expect, vi, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { LookupOutcome } from '$lib/server/entail';
import { makeD1 } from '$lib/server/test/d1';
import { POST } from './+server';

// Only the outbound calls are stubbed. classifySourceUrl stays real, so the
// URL recognition the endpoint depends on is exercised rather than mocked.
const lookupBlueskyPostResult = vi.hoisted(() =>
	vi.fn(async (_url: string): Promise<LookupOutcome> => ({ ok: false, reason: 'unavailable' }))
);
const classifyMediaUrlResult = vi.hoisted(() =>
	vi.fn(async (_url: string): Promise<LookupOutcome> => ({ ok: false, reason: 'unavailable' }))
);
const fetchTweetMediaUrl = vi.hoisted(() => vi.fn(async (_url: string): Promise<string | null> => null));

vi.mock('$lib/server/entail', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/entail')>();
	return { ...original, lookupBlueskyPostResult, classifyMediaUrlResult };
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
const MEDIA_URL = 'https://pbs.twimg.com/media/AbCdEf123?format=jpg&name=4096x4096';

const suggestions: LookupOutcome = {
	ok: true,
	suggestions: { tags: ['mammal', 'pink-hair'], rating: 'safe' }
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
	lookupBlueskyPostResult.mockReset();
	classifyMediaUrlResult.mockReset();
	fetchTweetMediaUrl.mockReset();
	lookupBlueskyPostResult.mockResolvedValue(suggestions);
	classifyMediaUrlResult.mockResolvedValue(suggestions);
	fetchTweetMediaUrl.mockResolvedValue(MEDIA_URL);
});

describe('POST /api/admin/tag-suggestions', () => {
	it('suggests tags for a bluesky source URL', async () => {
		const { platform } = makeEnv();
		const res = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			source: 'bluesky',
			tags: ['mammal', 'pink-hair'],
			rating: 'safe'
		});
		// The canonical URL, not the caller's string.
		expect(lookupBlueskyPostResult).toHaveBeenCalledWith(BSKY_POST);
		expect(fetchTweetMediaUrl).not.toHaveBeenCalled();
	});

	it('resolves an X post to its media URL, then classifies that', async () => {
		const { platform } = makeEnv();
		const res = await POST(event(platform, { sourcePostUrl: `${X_POST}/photo/1` }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			source: 'x',
			tags: ['mammal', 'pink-hair'],
			rating: 'safe'
		});
		expect(fetchTweetMediaUrl).toHaveBeenCalledWith(X_POST);
		// The media URL is what reaches entail.dev — never the tweet URL.
		expect(classifyMediaUrlResult).toHaveBeenCalledWith(MEDIA_URL);
		expect(lookupBlueskyPostResult).not.toHaveBeenCalled();
	});

	it('reads the stored source URL for an imageId', async () => {
		const { sqlite, platform } = makeEnv();
		insertImage(sqlite, BSKY_POST);
		const res = await POST(event(platform, { imageId: 7 }));
		expect(res.status).toBe(200);
		expect((await res.json()).source).toBe('bluesky');
		expect(lookupBlueskyPostResult).toHaveBeenCalledWith(BSKY_POST);
	});

	it('404s an unknown imageId', async () => {
		const { platform } = makeEnv();
		const res = await POST(event(platform, { imageId: 99 }));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'not_found' });
		expect(lookupBlueskyPostResult).not.toHaveBeenCalled();
	});

	it('422s a source we have no classifier for, including a stored empty one', async () => {
		const { sqlite, platform } = makeEnv();
		insertImage(sqlite, null);
		for (const body of [
			{ sourcePostUrl: 'https://furaffinity.net/view/12345/' },
			{ sourcePostUrl: '' },
			{ imageId: 7 }
		]) {
			const res = await POST(event(platform, body));
			expect(res.status).toBe(422);
			expect(await res.json()).toEqual({ error: 'unsupported_source' });
		}
		expect(lookupBlueskyPostResult).not.toHaveBeenCalled();
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
			[{ sourcePostUrl: `https://bsky.app/profile/a/post/${'x'.repeat(2100)}` }, undefined]
		];
		for (const [body, raw] of bad) {
			const res = await POST(event(platform, body, raw));
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: 'invalid_request' });
		}
	});

	it('200s with no tags when the classifier found nothing to suggest', async () => {
		const { platform } = makeEnv();
		// The classifier read the post and rated it; nothing cleared the
		// confidence floor. That is an answer, not a failure.
		lookupBlueskyPostResult.mockResolvedValue({
			ok: true,
			suggestions: { tags: [], rating: 'safe' }
		});
		const res = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ source: 'bluesky', tags: [], rating: 'safe' });
	});

	it('502s not_ready when the post is queued but unclassified', async () => {
		const { platform } = makeEnv();
		lookupBlueskyPostResult.mockResolvedValue({ ok: false, reason: 'not_ready' });
		const res = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: 'not_ready' });
	});

	it('502s unavailable for a failed lookup and for an unresolvable tweet', async () => {
		const { platform } = makeEnv();
		lookupBlueskyPostResult.mockResolvedValue({ ok: false, reason: 'unavailable' });
		const bsky = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(bsky.status).toBe(502);
		expect(await bsky.json()).toEqual({ error: 'unavailable' });

		fetchTweetMediaUrl.mockResolvedValue(null);
		const x = await POST(event(platform, { sourcePostUrl: X_POST }));
		expect(x.status).toBe(502);
		expect(await x.json()).toEqual({ error: 'unavailable' });
		expect(classifyMediaUrlResult).not.toHaveBeenCalled();
	});

	it('429s when entail.dev rate limited us', async () => {
		const { platform } = makeEnv();
		lookupBlueskyPostResult.mockResolvedValue({ ok: false, reason: 'rate_limited' });
		const res = await POST(event(platform, { sourcePostUrl: BSKY_POST }));
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: 'rate_limited' });
	});
});
