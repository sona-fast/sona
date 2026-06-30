import { getReadDb } from '$lib/server/db';
import { getPackBySlug } from '$lib/server/stickers';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform, params }) => {
	const db = getReadDb(platform!.env.DB);
	const pack = await getPackBySlug(db, params.slug, { publishedOnly: true });
	if (!pack) error(404, 'Pack not found');

	const stickerId = parseInt(params.id, 10);
	const sticker = pack.stickers.find((s) => s.id === stickerId);
	if (!sticker) error(404, 'Sticker not found');

	return { pack, sticker };
};
