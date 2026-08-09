import { error } from '@sveltejs/kit';
import { getReadDb } from '$lib/server/db';
import {
	vrAvatars,
	avatarCredits,
	avatarMedia,
	avatarPlatforms,
	artists,
	characters,
	images
} from '$lib/server/db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { getSettings } from '$lib/server/settings';
import { deriveModelPath, externalSiteName, isPermissiveVrLicense } from '$lib/vr';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, platform, url }) => {
	// read replica (eventually consistent); admin writes use the primary
	const db = getReadDb(platform!.env.DB);

	const avatar = await db
		.select({
			id: vrAvatars.id,
			slug: vrAvatars.slug,
			name: vrAvatars.name,
			description: vrAvatars.description,
			modelUrl: vrAvatars.modelUrl,
			modelFormat: vrAvatars.modelFormat,
			modelSizeBytes: vrAvatars.modelSizeBytes,
			externalUrl: vrAvatars.externalUrl,
			license: vrAvatars.license,
			downloadable: vrAvatars.downloadable,
			nsfw: vrAvatars.nsfw,
			createdAt: vrAvatars.createdAt,
			characterName: characters.name,
			posterUrl: images.imageUrl,
			posterWidth: images.width,
			posterHeight: images.height
		})
		.from(vrAvatars)
		.innerJoin(characters, eq(vrAvatars.characterId, characters.id))
		.leftJoin(images, eq(vrAvatars.posterImageId, images.id))
		.where(and(eq(vrAvatars.slug, params.slug), eq(vrAvatars.published, true)))
		.get();

	if (!avatar) {
		error(404, 'Avatar not found');
	}

	const [credits, media, platforms] = await Promise.all([
		db
			.select({
				artistId: avatarCredits.artistId,
				artistName: artists.name,
				artistAvatar: artists.avatarUrl,
				role: avatarCredits.role,
				roleLabel: avatarCredits.roleLabel
			})
			.from(avatarCredits)
			.innerJoin(artists, eq(avatarCredits.artistId, artists.id))
			.where(eq(avatarCredits.avatarId, avatar.id))
			.orderBy(asc(avatarCredits.position)),
		db
			.select({
				kind: avatarMedia.kind,
				url: avatarMedia.url,
				width: avatarMedia.width,
				height: avatarMedia.height
			})
			.from(avatarMedia)
			.where(eq(avatarMedia.avatarId, avatar.id))
			.orderBy(asc(avatarMedia.position)),
		db
			.select({ platform: avatarPlatforms.platform })
			.from(avatarPlatforms)
			.where(eq(avatarPlatforms.avatarId, avatar.id))
	]);

	// SAME-ORIGIN model path for the viewer/download (CSP connect-src 'self':
	// the raw, possibly cross-origin model_url must never reach the client-side
	// fetch). Null when the model is off-origin or absent → no viewer.
	const settings = await getSettings(db);
	const modelPath = deriveModelPath(avatar.modelUrl, {
		origin: url.origin,
		r2PublicUrl: settings.r2PublicUrl
	});

	return {
		avatar: {
			slug: avatar.slug,
			name: avatar.name,
			description: avatar.description,
			modelFormat: avatar.modelFormat,
			modelSizeBytes: avatar.modelSizeBytes,
			externalUrl: avatar.externalUrl,
			externalName: externalSiteName(avatar.externalUrl),
			license: avatar.license,
			nsfw: avatar.nsfw,
			createdAt: avatar.createdAt,
			characterName: avatar.characterName,
			posterUrl: avatar.posterUrl,
			posterWidth: avatar.posterWidth,
			posterHeight: avatar.posterHeight
		},
		modelPath,
		// Server-decided, mirroring the download endpoint's own enforcement — the
		// button renders only when the endpoint would say yes.
		downloadAllowed: avatar.downloadable && isPermissiveVrLicense(avatar.license) && !!modelPath,
		credits,
		media,
		platforms: platforms.map((p) => p.platform)
	};
};
