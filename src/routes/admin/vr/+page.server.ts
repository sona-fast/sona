import { sql, eq, desc } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { vrAvatars, avatarPlatforms, characters, images } from '$lib/server/db/schema';
import { vrPublishingEnabled, vrGaDate } from '$lib/server/vr-gate';
import { formatDate } from '$lib/index';
import { R2_FREE_TIER_BYTES } from '$lib/config';
import type { PageServerLoad } from './$types';

// Same DB-tracked usage mechanism as the settings Storage tab, against the
// shared R2_FREE_TIER_BYTES constant. Models live in the same bucket, so the
// line under the table adds SUM(model_size_bytes) to the image total.

export const load: PageServerLoad = async ({ platform }) => {
	const db = getDb(platform!.env.DB);

	const publishingEnabled = await vrPublishingEnabled(db, platform?.env);
	const gaDate = vrGaDate();

	const rows = await db
		.select({
			id: vrAvatars.id,
			slug: vrAvatars.slug,
			name: vrAvatars.name,
			modelUrl: vrAvatars.modelUrl,
			modelFormat: vrAvatars.modelFormat,
			modelSizeBytes: vrAvatars.modelSizeBytes,
			externalUrl: vrAvatars.externalUrl,
			license: vrAvatars.license,
			// Presence only feeds the effective Download state (admin-only page).
			permissionSource: vrAvatars.permissionSource,
			downloadable: vrAvatars.downloadable,
			nsfw: vrAvatars.nsfw,
			published: vrAvatars.published,
			characterName: characters.name,
			posterUrl: images.imageUrl,
			posterThumbUrl: images.thumbnailUrl
		})
		.from(vrAvatars)
		.innerJoin(characters, eq(vrAvatars.characterId, characters.id))
		.leftJoin(images, eq(vrAvatars.posterImageId, images.id))
		.orderBy(desc(vrAvatars.createdAt));

	// Platform counts per avatar (the table shows a count, not the badges).
	const platformCounts = new Map<number, number>();
	const platformRows = await db
		.select({ avatarId: avatarPlatforms.avatarId, n: sql<number>`COUNT(*)` })
		.from(avatarPlatforms)
		.groupBy(avatarPlatforms.avatarId);
	for (const p of platformRows) platformCounts.set(p.avatarId, p.n);

	// Storage line: DB-tracked totals, like the settings gauge (see R2_FREE_LIMIT
	// note above). Models count toward the same bucket as images.
	const imageBytes =
		(await db.select({ total: sql<number>`COALESCE(SUM(file_size), 0)` }).from(images).get())
			?.total ?? 0;
	const modelBytes =
		(
			await db
				.select({ total: sql<number>`COALESCE(SUM(model_size_bytes), 0)` })
				.from(vrAvatars)
				.get()
		)?.total ?? 0;

	return {
		publishingEnabled,
		// Display-formatted GA date for the gate copy (null once the flag retires).
		gaDateDisplay: gaDate ? formatDate(gaDate) : null,
		avatars: rows.map((r) => ({
			id: r.id,
			slug: r.slug,
			name: r.name,
			characterName: r.characterName,
			posterUrl: r.posterThumbUrl || r.posterUrl,
			hasModel: !!r.modelUrl,
			modelFormat: r.modelFormat,
			modelSizeBytes: r.modelSizeBytes,
			externalUrl: r.externalUrl,
			license: r.license,
			permissionSource: r.permissionSource,
			downloadable: r.downloadable,
			nsfw: r.nsfw,
			published: r.published,
			platformCount: platformCounts.get(r.id) ?? 0
		})),
		storage: { usedBytes: imageBytes + modelBytes, limitBytes: R2_FREE_TIER_BYTES }
	};
};
