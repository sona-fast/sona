import { getReadDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { images, artists, collections, conventions, characters } from '$lib/server/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import { cdnImage } from '$lib';
import type { PageServerLoad } from './$types';

async function fetchBlueskyAvatar(blueskyUrl: string): Promise<string | null> {
	try {
		const handle = blueskyUrl
			.replace(/^https?:\/\//, '')
			.replace(/^bsky\.app\/profile\//, '')
			.replace(/^@/, '')
			.replace(/\/$/, '')
			.trim();

		if (!handle) return null;

		const res = await fetch(
			`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`
		);
		if (!res.ok) return null;

		const profile = await res.json() as { avatar?: string };
		return profile.avatar || null;
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ platform }) => {
	// read replica (eventually consistent); admin writes use the primary
	const db = getReadDb(platform!.env.DB);
	const settings = await getSettings(db);

	// Cons that haven't finished yet (use end date when present), soonest first.
	const today = new Date().toISOString().slice(0, 10);

	const [imageCount, artistCount, collectionCount, upcomingCons] = await Promise.all([
		db.select({ count: sql<number>`COUNT(*)` }).from(images).where(sql`published = 1 AND parent_image_id IS NULL`).get(),
		db.select({ count: sql<number>`COUNT(*)` }).from(artists).get(),
		db.select({ count: sql<number>`COUNT(*)` }).from(collections).get(),
		db
			.select()
			.from(conventions)
			.where(sql`COALESCE(${conventions.endDate}, ${conventions.startDate}) >= ${today}`)
			.orderBy(asc(conventions.startDate))
	]);

	// Prefer the owner character's explicit reference image ("ref sheet") when it's
	// set AND still published; only then fall back to the fetched Bluesky avatar
	// (skipping that network call entirely when the reference image wins).
	let avatarUrl: string | null = null;
	const owner = await db
		.select({ referenceImageId: characters.referenceImageId })
		.from(characters)
		.where(eq(characters.isOwner, true))
		.get();
	if (owner?.referenceImageId) {
		const refImage = await db
			.select({ imageUrl: images.imageUrl })
			.from(images)
			.where(and(eq(images.id, owner.referenceImageId), eq(images.published, true)))
			.get();
		if (refImage) avatarUrl = cdnImage(refImage.imageUrl, 400);
	}
	if (!avatarUrl && settings.blueskyUrl) {
		avatarUrl = await fetchBlueskyAvatar(settings.blueskyUrl);
	}

	return {
		settings,
		avatarUrl,
		conventions: upcomingCons,
		stats: {
			artworks: imageCount?.count || 0,
			artists: artistCount?.count || 0,
			collections: collectionCount?.count || 0
		}
	};
};
