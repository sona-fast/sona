import { getDb } from '$lib/server/db';
import { getSettings } from '$lib/server/settings';
import { images, artists, collections } from '$lib/server/db/schema';
import { sql } from 'drizzle-orm';
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
	const db = getDb(platform!.env.DB);
	const settings = await getSettings(db);

	const [imageCount, artistCount, collectionCount] = await Promise.all([
		db.select({ count: sql<number>`COUNT(*)` }).from(images).where(sql`published = 1`).get(),
		db.select({ count: sql<number>`COUNT(*)` }).from(artists).get(),
		db.select({ count: sql<number>`COUNT(*)` }).from(collections).get()
	]);

	// Fetch avatar from Bluesky if configured
	let avatarUrl: string | null = null;
	if (settings.blueskyUrl) {
		avatarUrl = await fetchBlueskyAvatar(settings.blueskyUrl);
	}

	return {
		settings,
		avatarUrl,
		stats: {
			artworks: imageCount?.count || 0,
			artists: artistCount?.count || 0,
			collections: collectionCount?.count || 0
		}
	};
};
