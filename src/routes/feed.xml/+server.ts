import { error } from '@sveltejs/kit';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { images, artists, stickerPacks, vrAvatars, fursuitPhotos } from '$lib/server/db/schema';
import { getSettings, getRawSettings } from '$lib/server/settings';
import { withTimeout } from '$lib/server/timeout';
import { socialImage } from '$lib/social-image';
import { getMode } from '$lib/server/furtrack';
import { fursuitPhotoFromRow } from '$lib/server/fursuit-import';
import { etagMatches } from '$lib/server/vr-model-bytes';
import { renderFeed, rfc822, type FeedItem } from '$lib/server/feed';
import { feedKeyMatches } from '$lib/server/feed-key';
import type { RequestHandler } from './$types';

// GET /feed.xml — one RSS 2.0 document covering everything the site publishes:
// gallery art, sticker packs, VR avatars, and fursuit photos, merged newest
// first (SONA-172).
//
// Two documents share this handler. The public one is SFW and is what the
// footer link and the head autodiscovery tag point at. Presenting the owner's
// feed key (`?key=`) returns the same feed with adult work included and marked
// in band. A wrong or absent key returns the SFW document — not an error —
// because a 403 would confirm that a key exists to be guessed at.

/** Entries in the merged document. Bounds the response and the query fan-out;
 * a feed reader polling every 15 minutes never needs deeper history. */
const MAX_ITEMS = 50;

/**
 * Fursuit rows to read before the license predicate runs. The predicate is not
 * expressible in the query (`license` is a TEXT key resolved through LICENSES),
 * so filtering happens in JS and a straight LIMIT MAX_ITEMS could hand back
 * far fewer. Over-reading covers the common case where some recent photos are
 * non-displayable; the merge below caps the result either way.
 */
const FURSUIT_SCAN = MAX_ITEMS * 2;

/** Matches the settings timeout every public load uses: a hung read resolves to
 * the documented 503 rather than hanging until the Worker's own limit. */
const SETTINGS_TIMEOUT_MS = 3000;

/** Channel copy. Plain English constants rather than paraglide messages, for the
 * reason $lib/legal states about the policy text: this is document content, not
 * app chrome, and a feed request carries no UI locale to render it in. */
const SFW_DESCRIPTION =
	'New artwork, sticker packs, 3D avatars, and fursuit photos, newest first. The works listed here are shown with their creators\' permission and are not licensed for reuse.';
const ADULT_DESCRIPTION =
	'New artwork, sticker packs, 3D avatars, and fursuit photos, newest first. This edition includes adult work, marked on each entry. The works listed here are shown with their creators\' permission and are not licensed for reuse.';
const COPYRIGHT = 'All artwork belongs to their respective artists.';

/** Short, stable validator for a body. Hex-truncated SHA-256: a feed reader only
 * needs to tell "changed" from "unchanged", and a full digest doubles the header
 * for no gain. */
async function bodyEtag(body: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
	const hex = Array.from(new Uint8Array(digest).slice(0, 8), (b) =>
		b.toString(16).padStart(2, '0')
	).join('');
	return `"${hex}"`;
}

export const GET: RequestHandler = async ({ url, request, platform }) => {
	// The PRIMARY, for the reason /api/oembed documents at length: a replica
	// lagging behind a just-published upload would omit it, and a feed reader
	// that has already moved its cursor past that timestamp never asks again —
	// unlike a page load, a missed entry does not self-heal.
	const db = getDb(platform!.env.DB);

	// The gate reads RAW rows and fails CLOSED, exactly like /ai's load.
	// getSettings swallows D1 errors and returns DEFAULTS, where rssFeedEnabled
	// is default-ON — so on a read failure a cached-settings gate would publish
	// the feed for an owner who turned it off, and (with the NSFW keys equally
	// unreadable) could not tell a correct key from a wrong one either.
	const raw = await withTimeout(
		getRawSettings(db, ['rssFeedEnabled', 'rssNsfwEnabled', 'rssNsfwKey']),
		SETTINGS_TIMEOUT_MS,
		null
	);
	// 503, not 404, when the read itself failed: both refuse to serve, but a feed
	// reader treats 404 as "this feed is gone" and several stop polling or mark
	// the subscription dead, so one D1 latency spike would cost a subscriber
	// permanently with no self-heal. 503 is the same refusal spelled as "come
	// back", which is what a transient failure actually is.
	if (!raw) error(503, 'Service unavailable');
	// Absent means ON — only an explicit 'false' is an owner who opted out. This
	// one IS 404: the feed really is gone, and a reader dropping it is correct.
	if (raw.rssFeedEnabled === 'false') error(404, 'Not found');

	// Adult work is served only when the owner enabled it AND the request carries
	// the minted key. Both halves fail closed: an unreadable settings row was
	// already refused above (503), and a null key can never match.
	const adult =
		raw.rssNsfwEnabled === 'true' && feedKeyMatches(url.searchParams.get('key'), raw.rssNsfwKey ?? '');

	const origin = url.origin;

	// Art: parents only. A variant is another crop or palette of a piece already
	// listed, so including them would show a subscriber the same artwork several
	// times under near-identical titles.
	const artQuery = db
		.select({
			title: images.title,
			slug: images.slug,
			imageUrl: images.imageUrl,
			thumbnailUrl: images.thumbnailUrl,
			width: images.width,
			height: images.height,
			nsfw: images.nsfw,
			createdAt: images.createdAt,
			artistName: artists.name
		})
		.from(images)
		.leftJoin(artists, eq(images.artistId, artists.id))
		.where(
			and(
				eq(images.published, true),
				isNull(images.parentImageId),
				// The adult filter belongs in SQL, not in the loop below: with the
				// LIMIT applied first, 50 consecutive adult uploads would leave the
				// SFW document with no art at all while older SFW pieces sat unread.
				adult ? undefined : eq(images.nsfw, false)
			)
		)
		.orderBy(desc(images.createdAt))
		.limit(MAX_ITEMS);

	const packQuery = db
		.select({
			name: stickerPacks.name,
			slug: stickerPacks.slug,
			description: stickerPacks.description,
			coverImageUrl: stickerPacks.coverImageUrl,
			createdAt: stickerPacks.createdAt
		})
		.from(stickerPacks)
		.where(eq(stickerPacks.published, true))
		.orderBy(desc(stickerPacks.createdAt))
		.limit(MAX_ITEMS);

	const avatarQuery = db
		.select({
			name: vrAvatars.name,
			slug: vrAvatars.slug,
			description: vrAvatars.description,
			nsfw: vrAvatars.nsfw,
			createdAt: vrAvatars.createdAt,
			posterUrl: images.imageUrl,
			posterThumbUrl: images.thumbnailUrl,
			posterNsfw: images.nsfw
		})
		.from(vrAvatars)
		.leftJoin(images, eq(vrAvatars.posterImageId, images.id))
		.where(
			and(
				eq(vrAvatars.published, true),
				// Same reasoning as the art query, spelled against the effective flag
				// (`nsfw || posterNsfw`): both halves must be non-adult, and an avatar
				// with no poster row joins to NULL rather than to false.
				adult ? undefined : eq(vrAvatars.nsfw, false),
				adult ? undefined : or(isNull(images.nsfw), eq(images.nsfw, false))
			)
		)
		.orderBy(desc(vrAvatars.createdAt))
		.limit(MAX_ITEMS);

	// Fursuit photos ride the same off switch the gallery probe uses: with
	// FURTRACK_MODE unset the feature is off site-wide, and the feed must not be
	// the one surface that keeps publishing stored rows.
	const fursuitQuery =
		getMode(platform!.env) !== 'off'
			? db.select().from(fursuitPhotos).orderBy(desc(fursuitPhotos.createdAt)).limit(FURSUIT_SCAN)
			: [];

	// The reads are independent, so they go out together rather than one after
	// another. The settings read rides along too: it only supplies the channel
	// title and none of the queries above depend on it, so awaiting it separately
	// bought nothing but another serial round trip. Errors stay FATAL — no
	// per-query fallback — because a feed that silently drops a whole section
	// reads as "nothing new" to a subscriber, which is worse than the 5xx the
	// reader would simply retry.
	const [artRows, packRows, avatarRows, fursuitRows, settings] = await Promise.all([
		artQuery,
		packQuery,
		avatarQuery,
		fursuitQuery,
		getSettings(db)
	]);

	/** Absolute URL for an image column, capped the same way og:image is. */
	const absolute = (src: string | null, width?: number | null, height?: number | null) =>
		src ? socialImage(src, origin, width, height).url : undefined;

	const items: FeedItem[] = [];

	for (const row of artRows) {
		// Backstop, not the filter: the SQL predicate above already excluded these
		// rows from the public document. Kept because the failure it guards is a
		// leak — an adult title reaching the SFW feed — and a future edit to the
		// query would otherwise have nothing standing behind it.
		if (row.nsfw && !adult) continue;
		items.push({
			title: row.title,
			link: `${origin}/gallery/${encodeURIComponent(row.slug)}`,
			createdAt: row.createdAt,
			// No per-image description exists yet; SONA-173 adds the column and
			// wires it in here.
			imageUrl: absolute(row.thumbnailUrl ?? row.imageUrl, row.width, row.height),
			credit: row.artistName ?? undefined,
			nsfw: row.nsfw
		});
	}

	// ONE entry per pack, never per sticker: a 60-sticker import would otherwise
	// bury every other section under a single event.
	for (const row of packRows) {
		items.push({
			title: row.name,
			link: `${origin}/stickers/${encodeURIComponent(row.slug)}`,
			createdAt: row.createdAt,
			description: row.description ?? undefined,
			imageUrl: absolute(row.coverImageUrl)
		});
	}

	for (const row of avatarRows) {
		// Effective adult flag, matching /vr's loader: a SFW avatar with an adult
		// poster is adult as far as anything that renders the poster is concerned.
		// This computation is live — it marks the item on the keyed feed. The skip
		// below is the backstop only: the SQL already excluded these rows from the
		// public document, and it stays for the same leak-path reason as the art
		// loop's.
		const nsfw = row.nsfw || (row.posterNsfw ?? false);
		if (nsfw && !adult) continue;
		items.push({
			title: row.name,
			link: `${origin}/vr/${encodeURIComponent(row.slug)}`,
			createdAt: row.createdAt,
			description: row.description ?? undefined,
			imageUrl: absolute(row.posterThumbUrl ?? row.posterUrl),
			nsfw
		});
	}

	for (const row of fursuitRows) {
		const photo = fursuitPhotoFromRow(row);
		// The detail page's own predicate, applied here too: a license
		// reclassification must not leave a stored row syndicated after the page
		// that shows it started 404ing.
		if (!photo.license.displayable && !photo.permissionSource) continue;
		// Fursuit photos carry no adult flag because FurTrack does not host adult
		// work — the table has no nsfw column, so every one of these is SFW.
		items.push({
			title: photo.event
				? `${photo.character} by ${photo.photographer} at ${photo.event}`
				: `${photo.character} by ${photo.photographer}`,
			link: `${origin}/gallery/fursuit/${photo.id}`,
			createdAt: row.createdAt,
			description: photo.description,
			imageUrl: absolute(photo.imageUrl, photo.width, photo.height),
			credit: photo.photographer
		});
	}

	// One merged timeline. `created_at` is the only instant any of these tables
	// records; no publishedAt column exists, so a long-drafted piece dates from
	// its upload rather than its publication (accepted for v1).
	items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
	const capped = items.slice(0, MAX_ITEMS);

	const body = renderFeed(
		{
			title: settings.siteName,
			link: origin,
			description: adult ? ADULT_DESCRIPTION : SFW_DESCRIPTION,
			copyright: COPYRIGHT,
			// The address that returns THIS document — built from known parts, never
			// from the raw query. Echoing url.search made every tracking-param
			// variant (?utm_source=, ?fbclid=) a byte-distinct body and ETag, so each
			// one missed the shared cache and re-ran the whole fan-out against the
			// primary. The keyed edition names no address at all: its address IS the
			// key, and a document that spells it out hands the credential to anyone
			// who sees a rendered pane, a screenshot or a shared OPML file without
			// ever seeing the subscription URL. rel="self" is optional in RSS.
			selfUrl: adult ? undefined : `${origin}${url.pathname}`,
			lastBuildDate: capped.length ? (rfc822(capped[0].createdAt) ?? undefined) : undefined,
			adult
		},
		capped
	);

	const etag = await bodyEtag(body);
	const headers = new Headers({
		'Content-Type': 'application/rss+xml; charset=utf-8',
		etag,
		// Modest, matching the VR download route: an unpublish or a takedown should
		// stop being served promptly, and a feed reader polls on its own schedule
		// anyway. The keyed edition is `private`: its body varies on a credential in
		// the query string, and a shared cache configured to ignore query strings
		// would otherwise store the adult document under the public /feed.xml and
		// hand it to every anonymous visitor. 304 revalidation still works.
		'Cache-Control': adult ? 'private, max-age=60' : 'public, max-age=60, s-maxage=300'
	});
	// Belt and braces on the keyed edition: the address is unguessable, but a
	// crawler that is handed it (a pasted link, a referrer) must not index adult
	// work under this domain.
	if (adult) headers.set('X-Robots-Tag', 'noindex');

	if (etagMatches(request.headers.get('if-none-match'), etag)) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(body, { headers });
};
