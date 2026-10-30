import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ledgerDb, type Sqlite } from '$lib/server/test/ledger-db';
import { POST } from './+server';

// POST /api/admin/artist-telegram (SONA-236 paste a link: Add this Telegram to
// {name}), against the shipped schema. The admin gate in hooks.server.ts covers
// who may call it; hooks.server.test.ts checks it refuses a request without a
// session.
//
// What could go wrong: it replaces a Telegram the artist already has; it saves
// a link from another platform, or a raw post link, as the Telegram; it answers
// ok for an artist that doesn't exist; it writes another artist's row; it
// fetches the link.

const fetchSpy = vi.fn(() => {
	throw new Error('artist-telegram must not fetch');
});
beforeEach(() => {
	fetchSpy.mockClear();
	vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

async function post(platform: App.Platform, body: unknown, raw = false) {
	const request = new Request('http://localhost/api/admin/artist-telegram', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: raw ? (body as string) : JSON.stringify(body)
	});
	const res = await POST({ request, platform } as never);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const telegramOf = (sqlite: Sqlite, id: number) =>
	(sqlite.prepare('SELECT telegram_url AS t FROM artists WHERE id = ?').get(id) as { t: string | null }).t;

describe('POST /api/admin/artist-telegram', () => {
	it("saves the link's Telegram profile as the artist's Telegram when they have none", async () => {
		const { sqlite, platform } = ledgerDb();
		// A message link names the account; the profile is what's saved.
		const { status, body } = await post(platform, { artistId: 2, url: 'https://t.me/Artist_B/123' });
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, id: 2, name: 'Artist B', telegramUrl: 'https://t.me/Artist_B' });
		expect(telegramOf(sqlite, 2)).toBe('https://t.me/Artist_B');
		// Nobody else's row changes.
		expect(telegramOf(sqlite, 1)).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('fills a Telegram saved as an empty string', async () => {
		const { sqlite, platform } = ledgerDb();
		sqlite.prepare("UPDATE artists SET telegram_url = '' WHERE id = 1").run();
		const { status } = await post(platform, { artistId: 1, url: 't.me/artist_a' });
		expect(status).toBe(200);
		expect(telegramOf(sqlite, 1)).toBe('https://t.me/artist_a');
	});

	it('refuses, and keeps the saved one, when the artist already has a Telegram', async () => {
		const { sqlite, platform } = ledgerDb();
		sqlite.prepare("UPDATE artists SET telegram_url = 'https://t.me/the_real_one' WHERE id = 2").run();
		const res = await post(platform, { artistId: 2, url: 'https://t.me/someone_else' });
		expect(res).toEqual({ status: 409, body: { ok: false, reason: 'has_telegram' } });
		expect(telegramOf(sqlite, 2)).toBe('https://t.me/the_real_one');
	});

	it('refuses, and writes nothing, when another artist already has that Telegram', async () => {
		const { sqlite, platform } = ledgerDb();
		// Stored in another letter case and form: still the same account.
		sqlite.prepare("UPDATE artists SET telegram_url = 'http://telegram.me/Artist_A' WHERE id = 1").run();
		for (const url of ['https://t.me/artist_a', 'https://t.me/ARTIST_A/42']) {
			expect(await post(platform, { artistId: 2, url }), url).toEqual({
				status: 409,
				body: { ok: false, reason: 'telegram_taken_by_other' }
			});
		}
		expect(telegramOf(sqlite, 2)).toBeNull();
		expect(telegramOf(sqlite, 1)).toBe('http://telegram.me/Artist_A');
		// A different handle is still free to add.
		expect((await post(platform, { artistId: 2, url: 'https://t.me/artist_b' })).status).toBe(200);
	});

	it('refuses a link that names no Telegram account, and writes nothing', async () => {
		const { sqlite, platform } = ledgerDb();
		for (const url of [
			'https://x.com/artist_b/status/1',
			'https://bsky.app/profile/artist_b',
			// A private channel link: Telegram, but no handle.
			'https://t.me/c/123456/78',
			// A bare handle is a note, not a link to save.
			'@artist_b',
			'javascript:alert(1)'
		]) {
			expect(await post(platform, { artistId: 2, url }), url).toEqual({ status: 400, body: { ok: false, reason: 'not_telegram' } });
		}
		expect(telegramOf(sqlite, 2)).toBeNull();
	});

	it('answers 404 for an artist that does not exist', async () => {
		const { sqlite, platform } = ledgerDb();
		expect(await post(platform, { artistId: 99, url: 'https://t.me/artist_b' })).toEqual({
			status: 404,
			body: { ok: false, reason: 'missing' }
		});
		expect(sqlite.prepare("SELECT count(*) AS n FROM artists WHERE telegram_url IS NOT NULL").get()).toEqual({ n: 0 });
	});

	it('answers a body it cannot read with 400 invalid', async () => {
		const { platform } = ledgerDb();
		for (const body of [{}, { artistId: '2', url: 'https://t.me/a_b' }, { artistId: 2 }, { artistId: 1.5, url: 'https://t.me/a_b' }, null]) {
			expect(await post(platform, body), JSON.stringify(body)).toEqual({ status: 400, body: { ok: false, reason: 'invalid' } });
		}
		expect(await post(platform, 'not json', true)).toEqual({ status: 400, body: { ok: false, reason: 'invalid' } });
	});
});
