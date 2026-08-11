import { getReadDb } from '$lib/server/db';
import { vrAvatars, avatarPlatforms, images, fursuitPhotos } from '$lib/server/db/schema';
import { eq, desc, inArray, sql } from 'drizzle-orm';
import { getMode } from '$lib/server/furtrack';
import { stickerTabEnabled } from '$lib/server/stickers';
import { externalSiteName, modelFormatLabel } from '$lib/vr';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	// read replica (eventually consistent); admin writes use the primary
	const db = getReadDb(platform!.env.DB);

	const rows = await db
		.select({
			id: vrAvatars.id,
			slug: vrAvatars.slug,
			name: vrAvatars.name,
			nsfw: vrAvatars.nsfw,
			posterNsfw: images.nsfw,
			modelUrl: vrAvatars.modelUrl,
			modelFormat: vrAvatars.modelFormat,
			externalUrl: vrAvatars.externalUrl,
			posterUrl: images.imageUrl,
			posterThumbUrl: images.thumbnailUrl
		})
		.from(vrAvatars)
		.leftJoin(images, eq(vrAvatars.posterImageId, images.id))
		.where(eq(vrAvatars.published, true))
		.orderBy(desc(vrAvatars.createdAt));

	// Platform badges for this page's avatars, grouped per avatar.
	let platformsByAvatar: Record<number, string[]> = {};
	if (rows.length > 0) {
		const platformRows = await db
			.select({ avatarId: avatarPlatforms.avatarId, platform: avatarPlatforms.platform })
			.from(avatarPlatforms)
			.where(inArray(avatarPlatforms.avatarId, rows.map((r) => r.id)));
		for (const p of platformRows) {
			(platformsByAvatar[p.avatarId] ??= []).push(p.platform);
		}
	}

	// Whether to show the Fursuit pill — gated on the FurTrack flag the same way
	// the gallery and stickers pages are, so all tab bars agree. The Stickers
	// pill follows the shared stickerTabEnabled probe for the same reason.
	const fursuitEnabled =
		getMode(platform!.env) !== 'off' &&
		((await db.select({ n: sql<number>`COUNT(*)` }).from(fursuitPhotos).get())?.n ?? 0) > 0;
	const stickersEnabled = await stickerTabEnabled(db);

	const avatars = rows.map((r) => {
		const hasModel = !!r.modelUrl;
		return {
			slug: r.slug,
			name: r.name,
			// Effective public flag (avatar OR poster) — see the /vr/[slug] loader.
			nsfw: r.nsfw || (r.posterNsfw ?? false),
			posterUrl: r.posterThumbUrl || r.posterUrl,
			platforms: platformsByAvatar[r.id] ?? [],
			hasModel,
			formatLabel: hasModel ? modelFormatLabel(r.modelFormat) : null,
			// Off-site home shown as a badge only when there is no self-hosted model
			// (external-only entries) — a hosted model already gets the 3D badge.
			externalName: !hasModel && r.externalUrl ? externalSiteName(r.externalUrl) : null
		};
	});

	return { avatars, total: avatars.length, fursuitEnabled, stickersEnabled };
};
