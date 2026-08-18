import { fail, redirect } from '@sveltejs/kit';
import { desc } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { artists, characters, images } from '$lib/server/db/schema';
import { parseAvatarForm, validateAvatarRefs, validateAvatarMedia, insertAvatar } from '$lib/server/vr-avatars';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const [allArtists, allCharacters, allImages] = await Promise.all([
		db.select({ id: artists.id, name: artists.name }).from(artists).orderBy(artists.name),
		db.select({ id: characters.id, name: characters.name, isOwner: characters.isOwner }).from(characters).orderBy(characters.name),
		db
			.select({ id: images.id, imageUrl: images.imageUrl, thumbnailUrl: images.thumbnailUrl, title: images.title, nsfw: images.nsfw })
			.from(images)
			.orderBy(desc(images.createdAt))
	]);
	return {
		artists: allArtists,
		characters: allCharacters,
		images: allImages
	};
};

export const actions = {
	default: async ({ request, platform, url }) => {
		const db = getDb(platform!.env.DB);
		const data = await request.formData();
		const parsed = parseAvatarForm(data);
		if (!parsed.ok) return fail(400, { error: parsed.error });

		const refError = await validateAvatarRefs(db, parsed.input);
		if (refError) return fail(400, { error: refError });

		// Showcase media must be self-hosted (needs settings, so not in parse).
		const settings = await getSettings(db);
		const mediaError = validateAvatarMedia(platform?.env, settings, url.origin, parsed.input);
		if (mediaError) return fail(400, { error: mediaError });

		await insertAvatar(db, parsed.input);
		redirect(302, '/admin/vr');
	}
} satisfies Actions;
