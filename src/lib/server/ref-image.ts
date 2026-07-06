import { and, desc, eq } from 'drizzle-orm';
import { images, imageTags, tags, characters } from '$lib/server/db/schema';
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
 * (when that image is published); otherwise the most recent published image
 * tagged 'reference'. Returns null when neither exists.
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
			.where(and(eq(images.id, owner.referenceImageId), eq(images.published, true)))
			.get();
		if (designated) return designated;
	}

	return (
		(await db
			.select({ id: images.id, imageUrl: images.imageUrl })
			.from(images)
			.innerJoin(imageTags, eq(imageTags.imageId, images.id))
			.innerJoin(tags, eq(tags.id, imageTags.tagId))
			.where(and(eq(tags.name, REFERENCE_TAG), eq(images.published, true)))
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
 *    (`format=png` re-encodes losslessly, so sampled pixels are exact);
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
		return { src: `/cdn-cgi/image/format=png/${imageUrl}`, crossorigin: false };
	}

	// 3. UploadThing hosts.
	let host = '';
	try {
		host = new URL(imageUrl).hostname;
	} catch {
		// not an absolute URL — fall through to the proxy
	}
	if (host === 'ufs.sh' || host === 'utfs.io' || host.endsWith('.ufs.sh') || host.endsWith('.utfs.io')) {
		return { src: imageUrl, crossorigin: true };
	}

	// 4. By-ID proxy.
	return { src: `/api/admin/ref-image?id=${image.id}`, crossorigin: false };
}
