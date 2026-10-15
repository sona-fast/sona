import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ledgerDb, type Sqlite } from '$lib/server/test/ledger-db';
import { POST } from './+server';

// POST /api/admin/artist-from-link (SONA-236 paste a link), against the
// shipped schema. The admin gate in hooks.server.ts covers who may call it;
// hooks.server.test.ts checks it refuses a request without a session.

// Nothing in this endpoint may reach the network: the link is parsed, never
// fetched. Any fetch fails the test.
const fetchSpy = vi.fn(() => {
	throw new Error('artist-from-link must not fetch');
});
beforeEach(() => {
	fetchSpy.mockClear();
	vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function withSocials(sqlite: Sqlite) {
	// ledgerDb seeds Artist A (1) and Artist B (2) with no socials.
	sqlite.prepare("UPDATE artists SET twitter_url = 'https://twitter.com/Artist_B' WHERE id = 2").run();
	sqlite
		.prepare("INSERT INTO artists (id, name, instagram_url, created_at) VALUES (3, 'Insta twin', 'https://www.instagram.com/artist_b', '2026-10-01')")
		.run();
	sqlite.prepare("INSERT INTO artists (id, name, created_at) VALUES (4, 'artist_g', '2026-10-01')").run();
}

async function post(platform: App.Platform, body: unknown, raw = false) {
	const request = new Request('http://localhost/api/admin/artist-from-link', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: raw ? (body as string) : JSON.stringify(body)
	});
	const res = await POST({ request, platform } as never);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/admin/artist-from-link', () => {
	it('names the artist who holds the handle of an x.com post, stored as twitter.com', async () => {
		const { sqlite, platform } = ledgerDb();
		withSocials(sqlite);
		const { status, body } = await post(platform, { url: 'https://x.com/ARTIST_B/status/1843920577201' });
		expect(status).toBe(200);
		expect(body).toEqual({
			ok: true,
			platform: 'twitter',
			handle: 'ARTIST_B',
			profileUrl: 'https://twitter.com/ARTIST_B',
			// Only ids and names: the same handle on Instagram is someone else.
			matches: [{ id: 2, name: 'Artist B' }],
			nameMatches: []
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('offers an artist whose name equals the handle, without calling it a match', async () => {
		const { sqlite, platform } = ledgerDb();
		withSocials(sqlite);
		const { body } = await post(platform, { url: 'https://bsky.app/profile/artist_g/post/3m3a' });
		expect(body).toMatchObject({ ok: true, handle: 'artist_g', matches: [], nameMatches: [{ id: 4, name: 'artist_g' }] });
	});

	it('finds an artist stored with a legacy DeviantArt link, from either link shape', async () => {
		const { sqlite, platform } = ledgerDb();
		sqlite.prepare("UPDATE artists SET deviantart_url = 'https://someuser.deviantart.com/' WHERE id = 1").run();
		for (const url of ['https://someuser.deviantart.com/art/Title-123', 'https://www.deviantart.com/someuser/art/Title-123']) {
			const { body } = await post(platform, { url });
			expect(body, url).toMatchObject({ ok: true, handle: 'someuser', matches: [{ id: 1, name: 'Artist A' }] });
		}
	});

	it('finds nobody for a handle no artist holds', async () => {
		const { sqlite, platform } = ledgerDb();
		withSocials(sqlite);
		const { body } = await post(platform, { url: 'https://x.com/nobody_here/status/1' });
		expect(body).toMatchObject({ ok: true, handle: 'nobody_here', matches: [], nameMatches: [] });
	});

	it('says why a link names no artist, without reading the artist table', async () => {
		const { platform } = ledgerDb();
		for (const [url, reason] of [
			['https://www.furaffinity.net/view/58123456/', 'no_handle'],
			['https://t.me/c/123456/78', 'no_handle'],
			['https://vgen.co/artist_h', 'unsupported'],
			['javascript:alert(1)', 'invalid'],
			['artist g bsky', 'invalid']
		]) {
			expect(await post(platform, { url }), url).toEqual({ status: 200, body: { ok: false, reason } });
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('answers a body it cannot read with 400 invalid', async () => {
		const { platform } = ledgerDb();
		expect(await post(platform, 'not json', true)).toEqual({ status: 400, body: { ok: false, reason: 'invalid' } });
		expect(await post(platform, { url: 42 })).toEqual({ status: 400, body: { ok: false, reason: 'invalid' } });
		expect(await post(platform, {})).toEqual({ status: 400, body: { ok: false, reason: 'invalid' } });
	});
});
