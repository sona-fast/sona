import { json, error } from '@sveltejs/kit';
import { eq, and } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
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

	// The PRIMARY, deliberately, though this is an unauthenticated public read. A
	// replica lagging behind a just-published image would 404 here, and the embedder
	// caches that empty unfurl — unlike a page load, which a human simply reloads, a
	// cached negative does not self-heal when the replica catches up. This endpoint
	// is low-traffic, so offloading it to a replica buys nothing worth that.
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

	// Same image (and therefore same dimensions) og:image advertises: oEmbed must
	// not hand consumers a larger original than the page itself does.
	const image = socialImage(row.imageUrl, url.origin, row.width, row.height);

	return json({
		version: '1.0',
		type: 'photo',
		title: row.title,
		author_name: row.artistName ? `Commission by ${row.artistName}` : 'Commission',
		// The already-validated path we matched on — no decode/re-encode round trip.
		// The slug regex allows a trailing slash, which `trailingSlash: 'never'`
		// answers with a 308, so strip it rather than advertise a redirect.
		author_url: authorUrl ?? `${url.origin}${parsed.pathname.replace(/\/$/, '')}`,
		provider_name: settings.siteName,
		provider_url: url.origin,
		url: image.url,
		// socialImage() returns each axis it can vouch for AS THE URL ABOVE describes
		// it — per axis, so a row with one column NULL keeps the real value, and never
		// the stored value when the transform changed it. Placeholders are a last
		// resort for an axis it has no value for: oEmbed requires width/height for
		// type=photo (SONA-22 owns backfilling the columns).
		width: image.width ?? 1200,
		height: image.height ?? 800,
		// oEmbed's cache_age is a hint for the CONSUMER's own cache, unrelated to this
		// response's Cache-Control — Cloudflare does not treat a JSON API response as
		// cache-eligible without a per-zone Cache Rule, so this response is not
		// edge-cached at all and there is no mismatch to reconcile; lowering it
		// would only multiply consumer refetches.
		cache_age: 3600
	});
};
