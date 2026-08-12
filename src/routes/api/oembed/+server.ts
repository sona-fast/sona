import { json, error } from '@sveltejs/kit';
import { eq, and } from 'drizzle-orm';
import { getReadDb } from '$lib/server/db';
import { images, artists } from '$lib/server/db/schema';
import { getSettings } from '$lib/server/settings';
import { socialImage } from '$lib/social-image';
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

	// Only answer for our own host: an oEmbed provider that describes any URL it
	// is handed lets a third-party page advertise this endpoint as its own
	// discovery link. Host, not origin, so http on local dev still resolves.
	if (parsed.host !== url.host) error(404, 'Not an image URL');

	const match = parsed.pathname.match(/^\/gallery\/([^/]+)\/?$/);
	if (!match) error(404, 'Not an image URL');
	let slug: string;
	try {
		slug = decodeURIComponent(match[1]);
	} catch {
		// A malformed percent-escape throws URIError — a 400, not a 500.
		error(400, 'Invalid url');
	}

	// read replica (eventually consistent) — this is an unauthenticated public read
	const db = getReadDb(platform!.env.DB);

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

	// Same image (and therefore same dimensions) og:image advertises: oEmbed must
	// not hand consumers a larger original than the page itself does.
	const image = socialImage(row.imageUrl, url.origin, row.width, row.height);

	return json({
		version: '1.0',
		type: 'photo',
		title: row.title,
		author_name: row.artistName ? `Commission by ${row.artistName}` : 'Commission',
		// The already-validated path we matched on — no decode/re-encode round trip.
		author_url: authorUrl ?? `${url.origin}${parsed.pathname}`,
		provider_name: settings.siteName,
		provider_url: url.origin,
		url: image.url,
		width: image.width ?? 1200,
		height: image.height ?? 800,
		// Matches the s-maxage the response actually carries (hooks.server.ts shares
		// this path at the edge), so the payload doesn't promise a lifetime the
		// headers deny.
		cache_age: 300
	});
};
