import { error, fail, redirect } from '@sveltejs/kit';
import { asc, desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { artists, characters, images, vrAvatars, avatarCredits, avatarMedia, avatarPlatforms } from '$lib/server/db/schema';
import { parseAvatarForm, validateAvatarRefs, validateAvatarMedia, updateAvatar, deleteAvatar } from '$lib/server/vr-avatars';
import { vrPublishingEnabled } from '$lib/server/vr-gate';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform }) => {
	const db = getDb(platform!.env.DB);
	const avatarId = Number(params.id);

	const avatar = await db.select().from(vrAvatars).where(eq(vrAvatars.id, avatarId)).get();
	if (!avatar) error(404, 'Avatar not found');

	const [credits, media, platforms, allArtists, allCharacters, allImages, publishingEnabled] =
		await Promise.all([
			db
				.select({ artistId: avatarCredits.artistId, role: avatarCredits.role, roleLabel: avatarCredits.roleLabel })
				.from(avatarCredits)
				.where(eq(avatarCredits.avatarId, avatarId))
				.orderBy(asc(avatarCredits.position)),
			db
				.select({
					url: avatarMedia.url,
					kind: avatarMedia.kind,
					width: avatarMedia.width,
					height: avatarMedia.height
				})
				.from(avatarMedia)
				.where(eq(avatarMedia.avatarId, avatarId))
				.orderBy(asc(avatarMedia.position)),
			db
				.select({ platform: avatarPlatforms.platform })
				.from(avatarPlatforms)
				.where(eq(avatarPlatforms.avatarId, avatarId)),
			db.select({ id: artists.id, name: artists.name }).from(artists).orderBy(artists.name),
			db.select({ id: characters.id, name: characters.name }).from(characters).orderBy(characters.name),
			db
				.select({ id: images.id, imageUrl: images.imageUrl, thumbnailUrl: images.thumbnailUrl, title: images.title })
				.from(images)
				.orderBy(desc(images.createdAt)),
			vrPublishingEnabled(db, platform?.env)
		]);

	return {
		avatar,
		credits,
		media,
		platforms: platforms.map((p) => p.platform),
		artists: allArtists,
		characters: allCharacters,
		images: allImages,
		publishingEnabled
	};
};

export const actions = {
	save: async ({ params, request, platform, url }) => {
		const db = getDb(platform!.env.DB);
		const avatarId = Number(params.id);
		const existing = await db
			.select({ id: vrAvatars.id, published: vrAvatars.published, modelUrl: vrAvatars.modelUrl })
			.from(vrAvatars)
			.where(eq(vrAvatars.id, avatarId))
			.get();
		if (!existing) return fail(404, { error: 'Avatar not found.' });

		const data = await request.formData();
		const parsed = parseAvatarForm(data);
		if (!parsed.ok) return fail(400, { error: parsed.error });

		// Gate enforcement (SONA-124): editing the owner's existing data is never
		// gated, but PUBLISHING is — a draft can't flip to published while the
		// feature is pre-GA without a valid supporter key. Keeping an
		// already-published avatar published is not a publish.
		if (parsed.input.published && !existing.published && !(await vrPublishingEnabled(db, platform?.env))) {
			return fail(403, { error: 'VR avatars are in early access — publishing needs a valid supporter key until it opens for everyone.' });
		}

		const refError = await validateAvatarRefs(db, parsed.input, avatarId);
		if (refError) return fail(400, { error: refError });

		const settings = await getSettings(db);
		// Showcase media must be self-hosted (needs settings, so not in parse).
		const mediaError = validateAvatarMedia(platform?.env, settings, url.origin, parsed.input);
		if (mediaError) return fail(400, { error: mediaError });

		await updateAvatar({
			env: platform?.env,
			settings,
			db,
			id: avatarId,
			input: parsed.input,
			previousModelUrl: existing.modelUrl
		});
		redirect(302, '/admin/vr');
	},

	delete: async ({ params, platform }) => {
		const db = getDb(platform!.env.DB);
		const avatarId = Number(params.id);
		const existing = await db
			.select({ id: vrAvatars.id })
			.from(vrAvatars)
			.where(eq(vrAvatars.id, avatarId))
			.get();
		if (!existing) return fail(404, { error: 'Avatar not found.' });

		const settings = await getSettings(db);
		// Deleting is the owner disposing of their own data — never gated.
		await deleteAvatar({ env: platform?.env, settings, db, id: avatarId });
		redirect(302, '/admin/vr');
	}
} satisfies Actions;
