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
import { modelBytesServable } from '$lib/server/vr-model-bytes';
import { externalSiteName, isPermissiveVrLicense, viewerSupports } from '$lib/vr';
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
			// Server-side only (the downloadAllowed predicate below) — the recorded
			// permission source itself is deliberately never sent to the client.
			permissionSource: vrAvatars.permissionSource,
			downloadable: vrAvatars.downloadable,
			nsfw: vrAvatars.nsfw,
			posterNsfw: images.nsfw,
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
				// Socials render inline per credit row, the gallery's credited-artist
				// treatment (see gallery/[slug] socialLinks).
				artistTwitter: artists.twitterUrl,
				artistBluesky: artists.blueskyUrl,
				artistTelegram: artists.telegramUrl,
				artistFurAffinity: artists.furAffinityUrl,
				artistDeviantArt: artists.deviantArtUrl,
				artistPatreon: artists.patreonUrl,
				artistInstagram: artists.instagramUrl,
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

	// Whether anything server-side can actually produce the model's bytes
	// (R2 head / provider ownership — see modelBytesServable). Feeds both the
	// viewer path and the download button; the raw (possibly cross-origin)
	// model_url itself is NEVER sent to the client — the viewer fetches the
	// same-origin /vr/[slug]/model endpoint (connect-src permits no network
	// origin beyond 'self').
	const settings = await getSettings(db);
	const servable = avatar.modelUrl
		? await modelBytesServable({
				modelUrl: avatar.modelUrl,
				origin: url.origin,
				env: platform?.env,
				settings
			})
		: false;
	// Viewer only for formats it consumes (no FBX path leak — nothing renders it).
	const viewerPath =
		servable && viewerSupports(avatar.modelFormat) ? `/vr/${avatar.slug}/model` : null;

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
			// Effective flag: an NSFW-flagged gallery image used as the poster gates
			// the page even when the avatar itself isn't marked NSFW (poster is null
			// on a leftJoin miss).
			nsfw: avatar.nsfw || (avatar.posterNsfw ?? false),
			createdAt: avatar.createdAt,
			characterName: avatar.characterName,
			posterUrl: avatar.posterUrl,
			posterWidth: avatar.posterWidth,
			posterHeight: avatar.posterHeight
		},
		viewerPath,
		// Server-decided, mirroring the download endpoint's own enforcement — the
		// button renders only when the endpoint would say yes (downloadable +
		// permissive license + recorded permission + resolvable bytes).
		downloadAllowed:
			avatar.downloadable &&
			isPermissiveVrLicense(avatar.license) &&
			!!avatar.permissionSource &&
			servable,
		credits,
		media,
		platforms: platforms.map((p) => p.platform)
	};
};
