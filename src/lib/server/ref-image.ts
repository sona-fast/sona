import { and, desc, eq, isNull } from 'drizzle-orm';
import { artists, images, imageTags, tags, characters } from '$lib/server/db/schema';
import { socialAtHandle } from '$lib/social-label';
import { isUploadThingHost } from '$lib/img';
import type { getDb } from '$lib/server/db';

type Db = ReturnType<typeof getDb>;

// Same reference-sheet fallback tag as the /art page load.
const REFERENCE_TAG = 'reference';

export interface RefImage {
	id: number;
	imageUrl: string;
}

/**
 * Resolve the operator's reference sheet with the SAME precedence as the /art
 * page: an owner character's explicitly designated reference_image_id wins
 * (when that image is published and is not a variant); otherwise the most
 * recent published non-variant image tagged 'reference'. Returns null when
 * neither exists.
 *
 * The variant exclusion (SONA-18) has to be repeated here rather than inherited:
 * the color picker samples whatever this returns, and a sheet the picker offers
 * but /art refuses to show is worse than no picker at all.
 */
export async function resolveRefImage(db: Db): Promise<RefImage | null> {
	const owner = await db
		.select({ referenceImageId: characters.referenceImageId })
		.from(characters)
		.where(eq(characters.isOwner, true))
		// first owner by name — must match the /art load's precedence
		.orderBy(characters.name)
		.get();

	if (owner?.referenceImageId != null) {
		const designated = await db
			.select({ id: images.id, imageUrl: images.imageUrl })
			.from(images)
			.where(
				and(
					eq(images.id, owner.referenceImageId),
					eq(images.published, true),
					isNull(images.parentImageId)
				)
			)
			.get();
		if (designated) return designated;
	}

	return (
		(await db
			.select({ id: images.id, imageUrl: images.imageUrl })
			.from(images)
			.innerJoin(imageTags, eq(imageTags.imageId, images.id))
			.innerJoin(tags, eq(tags.id, imageTags.tagId))
			.where(
				and(
					eq(tags.name, REFERENCE_TAG),
					eq(images.published, true),
					isNull(images.parentImageId)
				)
			)
			.orderBy(desc(images.createdAt))
			.get()) ?? null
	);
}

/** How the client should load the sheet into a canvas WITHOUT tainting it. */
export interface RefImageSource {
	src: string;
	crossorigin: boolean;
}

/**
 * Pick the client image-loading strategy for the ref-sheet color picker:
 * 1. root-relative / same-origin URL → as-is (never taints the canvas);
 * 2. our own R2 public URL in prod → same-origin Cloudflare image transform
 *    (`format=png` re-encodes losslessly and `width=1600,fit=scale-down` caps
 *    the decode cost, so sampled pixels are exact within the ≤1600px working
 *    image the picker samples from);
 * 3. UploadThing (ufs.sh / utfs.io) → raw URL + crossorigin="anonymous"
 *    (UT serves Access-Control-Allow-Origin: *);
 * 4. anything else (incl. dev pointing at prod-origin URLs) → the admin-gated
 *    by-ID proxy endpoint, which never accepts a URL parameter (SSRF).
 */
export function refImageSource(
	image: RefImage,
	opts: { origin: string; r2PublicUrl: string; dev: boolean }
): RefImageSource {
	const { imageUrl } = image;

	// 1. Same-origin or root-relative (but not protocol-relative `//host/...`).
	if (imageUrl.startsWith('/') && !imageUrl.startsWith('//')) {
		return { src: imageUrl, crossorigin: false };
	}
	if (imageUrl.startsWith(opts.origin + '/')) {
		return { src: imageUrl, crossorigin: false };
	}

	// 2. R2-owned absolute URL, prod only (the CF edge isn't there in dev).
	const r2 = opts.r2PublicUrl.trim().replace(/\/+$/, '');
	if (!opts.dev && r2 && imageUrl.startsWith(r2 + '/')) {
		return { src: `/cdn-cgi/image/format=png,width=1600,fit=scale-down/${imageUrl}`, crossorigin: false };
	}

	// 3. UploadThing hosts.
	let host = '';
	try {
		host = new URL(imageUrl).hostname;
	} catch {
		// not an absolute URL — fall through to the proxy
	}
	if (isUploadThingHost(host)) {
		return { src: imageUrl, crossorigin: true };
	}

	// 4. By-ID proxy.
	return { src: `/api/admin/ref-image?id=${image.id}`, crossorigin: false };
}

/** Who to credit for the reference sheet, for the con card's spine line. */
export interface RefImageCredit {
	name: string;
	/** The artist's @handle where one can be derived, for a shorter spine. */
	handle: string | null;
}

/** Platforms the spine credit will read a handle from, best first. A card has
 *  room for one, and this is the order an artist is most likely to want. */
const CREDIT_PLATFORMS = ['bluesky', 'twitter', 'telegram', 'instagram', 'furaffinity'] as const;

/**
 * The artist behind an image, with a handle for the con card's spine credit.
 * Null when the image has no artist row (imports without attribution).
 */
export async function refImageCredit(db: Db, imageId: number): Promise<RefImageCredit | null> {
	const row = await db
		.select({
			name: artists.name,
			bluesky: artists.blueskyUrl,
			twitter: artists.twitterUrl,
			telegram: artists.telegramUrl,
			instagram: artists.instagramUrl,
			furaffinity: artists.furAffinityUrl
		})
		.from(artists)
		.innerJoin(images, eq(images.artistId, artists.id))
		.where(eq(images.id, imageId))
		.get();
	if (!row) return null;

	const handle =
		CREDIT_PLATFORMS.map((platform) => socialAtHandle(platform, row[platform])).find(Boolean) ??
		null;
	return { name: row.name, handle };
}
