import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { artists } from '$lib/server/db/schema';
import { saveManualPack, resolveOrCreateArtist, parseStickerFormInputs } from '$lib/server/sticker-import';
import { sanitizeText, sanitizeUrl } from '$lib/server/validate';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	// Character is implicit (the site's one character) — not chosen in the UI.
	const allArtists = await db.select({ id: artists.id, name: artists.name }).from(artists).orderBy(artists.name);
	return { artists: allArtists };
};

export const actions = {
	default: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const settings = await getSettings(db);
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
			twitterUrl: sanitizeUrl(data.get('twitter') as string),
			blueskyUrl: sanitizeUrl(data.get('bluesky') as string),
			telegramUrl: sanitizeUrl(data.get('artistTelegram') as string),
			furAffinityUrl: sanitizeUrl(data.get('furaffinity') as string),
			deviantArtUrl: sanitizeUrl(data.get('deviantart') as string),
			patreonUrl: sanitizeUrl(data.get('patreon') as string),
			instagramUrl: sanitizeUrl(data.get('instagram') as string)
		});
		// Default artist is optional — stickers with none import as "unattributed".
		const stickerInputs = parseStickerFormInputs(data, defaultArtistId);

		try {
			await saveManualPack({
				env: platform?.env,
				settings,
				db,
				input: { name, description, coverImageUrl, managerArtistId, telegramUrl, published, stickerInputs }
			});
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not save pack.' });
		}

		redirect(302, '/admin/stickers');
	}
} satisfies Actions;
