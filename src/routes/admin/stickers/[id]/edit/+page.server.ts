import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { artists, stickerPacks, stickers, stickerEmojis } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { updateManualPack, resolveOrCreateArtist, parseStickerFormInputs } from '$lib/server/sticker-import';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import { normalizeSocialUrl } from '$lib/server/handle-normalize';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform }) => {
	const db = getDb(platform!.env.DB);
	const packId = Number(params.id);

	const pack = await db.select().from(stickerPacks).where(eq(stickerPacks.id, packId)).get();
	if (!pack) error(404, 'Pack not found');

	const stickerRows = await db
		.select()
		.from(stickers)
		.where(eq(stickers.packId, packId))
		.orderBy(stickers.position);

	// Load emoji via a subquery on packId (not an IN-list of every sticker id —
	// a pack can exceed D1's ~100 bound-parameter cap).
	const emojiMap = new Map<number, string[]>();
	if (stickerRows.length > 0) {
		const allEmojis = await db
			.select()
			.from(stickerEmojis)
			.where(
				inArray(
					stickerEmojis.stickerId,
					db.select({ id: stickers.id }).from(stickers).where(eq(stickers.packId, packId))
				)
			);
		for (const e of allEmojis) {
			const list = emojiMap.get(e.stickerId) ?? [];
			list.push(e.emoji);
			emojiMap.set(e.stickerId, list);
		}
	}

	const stickerData = stickerRows.map((s) => ({ ...s, emojis: emojiMap.get(s.id) ?? [] }));

	// Character is implicit (the site's one character) — not chosen in the UI.
	const allArtists = await db.select({ id: artists.id, name: artists.name }).from(artists).orderBy(artists.name);

	return { pack, stickers: stickerData, artists: allArtists };
};

export const actions = {
	default: async ({ params, request, platform }) => {
		const db = getDb(platform!.env.DB);
		const settings = await getSettings(db);
		const packId = Number(params.id);
		const data = await request.formData();

		const name = sanitizeText(data.get('name') as string, 200);
		const description = sanitizeText(data.get('description') as string, 1000) || null;
		const coverImageUrl = sanitizeUrl(data.get('coverImageUrl') as string);
		const managerArtistIdRaw = data.get('managerArtistId') as string;
		const managerArtistId = managerArtistIdRaw && managerArtistIdRaw !== '' ? Number(managerArtistIdRaw) : null;
		const telegramUrl = sanitizeUrl(data.get('telegramUrl') as string);
		const published = data.get('published') === '1';

		const defaultArtistIdRaw = data.get('defaultArtistId') as string;
		const newArtistName = sanitizeText(data.get('newArtistName') as string, 200);

		if (!name) return fail(400, { error: 'Pack name is required.' });

		const defaultArtistId = await resolveOrCreateArtist(db, {
			artistId: defaultArtistIdRaw && defaultArtistIdRaw !== 'new' ? defaultArtistIdRaw : null,
			artistName: newArtistName,
			twitterUrl: normalizeSocialUrl('twitter', data.get('twitter') as string) || null,
			blueskyUrl: normalizeSocialUrl('bluesky', data.get('bluesky') as string) || null,
			telegramUrl: normalizeSocialUrl('telegram', data.get('artistTelegram') as string) || null,
			furAffinityUrl: normalizeSocialUrl('furaffinity', data.get('furaffinity') as string) || null,
			deviantArtUrl: normalizeSocialUrl('deviantart', data.get('deviantart') as string) || null,
			patreonUrl: normalizeSocialUrl('patreon', data.get('patreon') as string) || null,
			instagramUrl: normalizeSocialUrl('instagram', data.get('instagram') as string) || null
		});
		// Default artist is optional — stickers with none stay "unattributed".
		const stickerInputs = parseStickerFormInputs(data, defaultArtistId);

		try {
			await updateManualPack({
				env: platform?.env,
				settings,
				db,
				packId,
				input: { name, description, coverImageUrl, managerArtistId, telegramUrl, published, stickerInputs }
			});
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not save pack.' });
		}

		redirect(302, '/admin/stickers');
	}
} satisfies Actions;
