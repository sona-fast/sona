import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { isTelegramEnabled } from '$lib/server/telegram';
import { listPacks, clearStickerTabCache } from '$lib/server/stickers';
import { deletePack } from '$lib/server/sticker-import';
import { stickerPacks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
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

		const row = await db.select({ published: stickerPacks.published }).from(stickerPacks).where(eq(stickerPacks.id, id)).get();
		if (!row) return fail(404, { error: 'Pack not found.' });

		await db.update(stickerPacks).set({ published: !row.published }).where(eq(stickerPacks.id, id));
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
