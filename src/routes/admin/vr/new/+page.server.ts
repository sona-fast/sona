import { fail, redirect } from '@sveltejs/kit';
import { desc } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { artists, characters, images } from '$lib/server/db/schema';
import { parseAvatarForm, validateAvatarRefs, insertAvatar } from '$lib/server/vr-avatars';
import { vrPublishingEnabled, vrGaDate } from '$lib/server/vr-gate';
import { formatDate } from '$lib/index';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);
	const publishingEnabled = await vrPublishingEnabled(db);
	const gaDate = vrGaDate();
	const [allArtists, allCharacters, allImages] = await Promise.all([
		db.select({ id: artists.id, name: artists.name }).from(artists).orderBy(artists.name),
		db.select({ id: characters.id, name: characters.name }).from(characters).orderBy(characters.name),
		db
			.select({ id: images.id, imageUrl: images.imageUrl, thumbnailUrl: images.thumbnailUrl, title: images.title })
			.from(images)
			.orderBy(desc(images.createdAt))
	]);
	return {
		publishingEnabled,
		gaDateDisplay: gaDate ? formatDate(gaDate) : null,
		artists: allArtists,
		characters: allCharacters,
		images: allImages
	};
};

export const actions = {
	default: async ({ request, platform }) => {
		const db = getDb(platform!.env.DB);
		// Server-side gate enforcement (SONA-124): the gated UI is presentation;
		// creating an avatar is refused here regardless of what was submitted.
		if (!(await vrPublishingEnabled(db))) {
			return fail(403, { error: 'VR avatars is in early access — creating avatars needs a valid supporter key until it opens for everyone.' });
		}

		const data = await request.formData();
		const parsed = parseAvatarForm(data);
		if (!parsed.ok) return fail(400, { error: parsed.error });

		const refError = await validateAvatarRefs(db, parsed.input);
		if (refError) return fail(400, { error: refError });

		await insertAvatar(db, parsed.input);
		redirect(302, '/admin/vr');
	}
} satisfies Actions;
