import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { isTelegramEnabled } from '$lib/server/telegram';
import { listPacks, clearStickerTabCache } from '$lib/server/stickers';
import { deletePack } from '$lib/server/sticker-import';
import { stickerPacks, stickers } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { checkUnhide, clearKeepPrivate } from '$lib/server/artist-visibility';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const telegramEnabled = isTelegramEnabled(platform?.env);
	const packs = await listPacks(db, { publishedOnly: false });
	return { telegramEnabled, packs };
};

export const actions = {
	togglePublished: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid pack id.' });

		const row = await db
			.select({ published: stickerPacks.published, managerArtistId: stickerPacks.managerArtistId })
			.from(stickerPacks)
			.where(eq(stickerPacks.id, id))
			.get();
		if (!row) return fail(404, { error: 'Pack not found.' });

		// Publishing a pack that credits a Keep private artist makes them public,
		// so ask first (SONA-236). Both the manager and every stored sticker's
		// artist: a re-import into the pack can save stickers under another
		// artist, and the public pages show what's stored.
		let credited: (number | null)[] = [];
		if (!row.published) {
			const stickerArtists = await db
				.selectDistinct({ artistId: stickers.artistId })
				.from(stickers)
				.where(eq(stickers.packId, id))
				.all();
			credited = [row.managerArtistId, ...stickerArtists.map((s) => s.artistId)];
		}
		const { refusal, unhide } = await checkUnhide(db, data, credited);
		if (refusal) return refusal;

		await db.update(stickerPacks).set({ published: !row.published }).where(eq(stickerPacks.id, id));
		await clearKeepPrivate(db, unhide);
		// Same-isolate immediacy for the nav/tab probe; other isolates converge by TTL.
		clearStickerTabCache();
		return { toggled: true };
	},

	delete: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		const settings = await getSettings(db);
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid pack id.' });

		const row = await db.select({ id: stickerPacks.id }).from(stickerPacks).where(eq(stickerPacks.id, id)).get();
		if (!row) return fail(404, { error: 'Pack not found.' });

		await deletePack({ env: platform?.env, settings, db, packId: id });
		return { deleted: true };
	}
} satisfies Actions;
