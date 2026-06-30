import { json, error } from '@sveltejs/kit';
import { eq, and } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { images, artists } from '$lib/server/db/schema';
import { getSettings } from '$lib/server/settings';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, platform }) => {
	const target = url.searchParams.get('url');
	if (!target) error(400, 'Missing url param');

	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		error(400, 'Invalid url');
	}

	const match = parsed.pathname.match(/^\/gallery\/([^/]+)\/?$/);
	if (!match) error(404, 'Not an image URL');
	const slug = decodeURIComponent(match[1]);

	const db = getDb(platform!.env.DB);

	const row = await db
		.select({
			title: images.title,
			imageUrl: images.imageUrl,
			width: images.width,
			height: images.height,
			artistName: artists.name,
			artistTwitter: artists.twitterUrl,
			artistBluesky: artists.blueskyUrl,
			artistFurAffinity: artists.furAffinityUrl,
			artistDeviantArt: artists.deviantArtUrl,
			artistInstagram: artists.instagramUrl,
			artistPatreon: artists.patreonUrl,
			artistTelegram: artists.telegramUrl
		})
		.from(images)
		.leftJoin(artists, eq(images.artistId, artists.id))
		.where(and(eq(images.slug, slug), eq(images.published, true)))
		.get();

	if (!row) error(404, 'Image not found');

	const authorUrl =
		row.artistBluesky ||
		row.artistTwitter ||
		row.artistFurAffinity ||
		row.artistDeviantArt ||
		row.artistInstagram ||
		row.artistPatreon ||
		row.artistTelegram ||
		null;

	const settings = await getSettings(db);

	return json({
		version: '1.0',
		type: 'photo',
		title: row.title,
		author_name: row.artistName ? `Commission by ${row.artistName}` : 'Commission',
		author_url: authorUrl ?? `${url.origin}/gallery/${slug}`,
		provider_name: settings.siteName,
		provider_url: url.origin,
		url: row.imageUrl,
		width: row.width ?? 1200,
		height: row.height ?? 800,
		cache_age: 3600
	});
};
