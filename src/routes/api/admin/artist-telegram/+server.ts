import { json } from '@sveltejs/kit';
import { and, eq, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { artists } from '$lib/server/db/schema';
import { parseArtistLink } from '$lib/server/artist-from-link';
import { findLocalArtistsByHandle, normalizeSocialUrl } from '$lib/server/handle-normalize';
import type { RequestHandler } from './$types';

// POST /api/admin/artist-telegram (admin-only via hooks: everything under /api
// except /api/cron/ requires the admin session).
//
// Paste a link (SONA-236): body { artistId, url } saves the Telegram a t.me
// link names as that artist's Telegram, for the commission form's "Add this
// Telegram to {name}". It only fills an empty Telegram: one already saved is
// never replaced from here, so a pasted link can't quietly point the artist's
// Open chat at someone else. Like Add {handle} as a new artist (/api/artists),
// it isn't behind the ledger's early-access gate: it writes the artist, not
// the ledger. The link is parsed, never fetched, and never logged.
//
// Answers { ok: true, id, name, telegramUrl }, or { ok: false, reason }:
// - 400 `invalid`: the body isn't { artistId: integer, url: string }.
// - 400 `not_telegram`: the link names no Telegram account.
// - 404 `missing`: no artist has that id.
// - 409 `has_telegram`: the artist already has a Telegram.
// - 409 `telegram_taken_by_other`: another artist already has this Telegram.

export const POST: RequestHandler = async ({ request, platform }) => {
	let body: { artistId?: unknown; url?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}
	const { artistId, url } = body ?? {};
	if (typeof url !== 'string' || typeof artistId !== 'number' || !Number.isSafeInteger(artistId) || artistId < 1) {
		return json({ ok: false, reason: 'invalid' }, { status: 400 });
	}

	const parsed = parseArtistLink(url);
	if (!parsed.ok || parsed.platform !== 'telegram') return json({ ok: false, reason: 'not_telegram' }, { status: 400 });
	const telegramUrl = normalizeSocialUrl('telegram', parsed.handle);
	if (!telegramUrl) return json({ ok: false, reason: 'not_telegram' }, { status: 400 });

	const db = getDb(platform!.env.DB);
	// One Telegram is one person: a handle another artist holds (in any letter
	// case or link form, matched as the link lookup does) isn't saved here too.
	const holders = await db
		.select({ id: artists.id, telegramUrl: artists.telegramUrl })
		.from(artists)
		.where(and(ne(artists.id, artistId), isNotNull(artists.telegramUrl), ne(artists.telegramUrl, '')));
	if (findLocalArtistsByHandle(holders, 'telegram', [parsed.handle]).length > 0) {
		return json({ ok: false, reason: 'telegram_taken_by_other' }, { status: 409 });
	}
	// The empty check rides the write itself, so two tabs adding different
	// handles at once can't both land: the second finds the first's.
	const [updated] = await db
		.update(artists)
		.set({ telegramUrl })
		.where(and(eq(artists.id, artistId), or(isNull(artists.telegramUrl), eq(artists.telegramUrl, ''))))
		.returning({ id: artists.id, name: artists.name });
	if (updated) return json({ ok: true, id: updated.id, name: updated.name, telegramUrl });

	const exists = await db.select({ id: artists.id }).from(artists).where(eq(artists.id, artistId)).get();
	return exists
		? json({ ok: false, reason: 'has_telegram' }, { status: 409 })
		: json({ ok: false, reason: 'missing' }, { status: 404 });
};
