import { getReadDb } from '$lib/server/db';
import { vrAvatars, avatarPlatforms, images } from '$lib/server/db/schema';
import { eq, desc, inArray } from 'drizzle-orm';
import { getMode } from '$lib/server/furtrack';
import { fursuitPhotosExist } from '$lib/server/fursuit-import';
import { stickerTabEnabled } from '$lib/server/stickers';
import { PROBE_TIMEOUT_MS } from '$lib/server/nav-gating';
import { withTimeout } from '$lib/server/timeout';
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
	// the gallery and stickers pages are, so all tab bars agree; the shared
	// cached probe replaces the old per-request COUNT so a D1 stall can't hang
	// this page. Both probes are wrapped AT CREATION (a rejection can never
	// float unhandled) and awaited together. Fail directions: stickers open
	// (dead link beats a hidden healthy section), fursuit closed (its target
	// view silently falls back to artwork when the flag is off, so a
	// false-open pill is a link to nowhere) — matching the gallery.
	const stickersProbe = withTimeout(stickerTabEnabled(db), PROBE_TIMEOUT_MS, true);
	const fursuitProbe =
		getMode(platform!.env) !== 'off'
			? withTimeout(fursuitPhotosExist(db), PROBE_TIMEOUT_MS, false)
			: Promise.resolve(false);
	const [stickersEnabled, fursuitEnabled] = await Promise.all([stickersProbe, fursuitProbe]);

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
