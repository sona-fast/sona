import { getReadDb } from '$lib/server/db';
import { getSettings, toPublicSettings } from '$lib/server/settings';
import { images, artists, collections, conventions } from '$lib/server/db/schema';
import { asc, sql } from 'drizzle-orm';
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

	// Fetch avatar from Bluesky if configured
	let avatarUrl: string | null = null;
	if (settings.blueskyUrl) {
		avatarUrl = await fetchBlueskyAvatar(settings.blueskyUrl);
	}

	return {
		settings: toPublicSettings(settings),
		avatarUrl,
		conventions: upcomingCons,
		stats: {
			artworks: imageCount?.count || 0,
			artists: artistCount?.count || 0,
			collections: collectionCount?.count || 0
		}
	};
};
