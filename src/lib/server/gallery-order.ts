import { and, asc, desc, eq, isNull, like, sql, type SQL } from 'drizzle-orm';
import { artists, images } from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';
import type { GallerySort } from '$lib/gallery';

// The gallery grid's filter and order, in one place, so the grid
// ((public)/gallery/+page.server.ts) and the detail page's previous/next
// links ((public)/gallery/[slug]) can't disagree about which piece comes next
// (SONA-179).

/** The grid filters a detail page can carry. `artist` is the resolved current
 *  name: the grid resolves a former name before it filters. */
export interface GalleryFilters {
	search: string;
	tag: string;
	artist: string;
	character: string;
}

/**
 * WHERE conditions for the artwork grid: published, non-variant (a variant
 * never gets a card of its own, only its parent does), narrowed by the active
 * filters. Callers join `artists` on images.artistId for the artist filter.
 */
export function galleryConditions(f: GalleryFilters): SQL[] {
	const conditions: SQL[] = [eq(images.published, true), isNull(images.parentImageId)];
	if (f.search) conditions.push(like(images.title, `%${f.search}%`));
	if (f.artist) conditions.push(eq(artists.name, f.artist));
	if (f.tag) {
		conditions.push(
			sql`${images.id} IN (SELECT image_id FROM image_tags INNER JOIN tags ON tags.id = image_tags.tag_id WHERE tags.name = ${f.tag})`
		);
	}
	if (f.character) {
		conditions.push(
			sql`${images.id} IN (SELECT image_id FROM image_characters INNER JOIN characters ON characters.id = image_characters.character_id WHERE characters.name = ${f.character})`
		);
	}
	return conditions;
}

// The commissioned sorts fall back to the upload date for undated pieces.
const commissionedKey = sql`COALESCE(${images.commissionedAt}, ${images.createdAt})`;

function sortSpec(sort: GallerySort): { key: SQL; descending: boolean } {
	switch (sort) {
		case 'oldest':
			return { key: sql`${images.createdAt}`, descending: false };
		case 'commissioned-newest':
			return { key: commissionedKey, descending: true };
		case 'commissioned-oldest':
			return { key: commissionedKey, descending: false };
		default:
			return { key: sql`${images.createdAt}`, descending: true };
	}
}

/**
 * ORDER BY for the grid. The id runs in the same direction as the sort key and
 * breaks ties, so pieces uploaded in the same instant keep one fixed order:
 * the detail page's neighbors are only right if the grid's order is total.
 */
export function galleryOrderBy(sort: GallerySort): SQL[] {
	const { key, descending } = sortSpec(sort);
	return descending ? [sql`${key} DESC`, desc(images.id)] : [sql`${key} ASC`, asc(images.id)];
}

/** One end of the detail page's previous/next pair. */
export interface GalleryNeighbor {
	slug: string;
	title: string;
	imageUrl: string;
}

/**
 * The grid pieces either side of `anchor` under the same filters and sort: the
 * previous and next cards, as the grid would lay them out across its pages.
 * Null at either end. `anchor` is a grid piece (a variant's parent, never the
 * variant), and need not match the filters itself.
 */
export async function galleryNeighbors(
	db: Database,
	filters: GalleryFilters,
	sort: GallerySort,
	anchor: { id: number; createdAt: string; commissionedAt: string | null }
): Promise<{ prev: GalleryNeighbor | null; next: GalleryNeighbor | null }> {
	const { key, descending } = sortSpec(sort);
	const value = sort.startsWith('commissioned-') ? (anchor.commissionedAt ?? anchor.createdAt) : anchor.createdAt;
	const conditions = galleryConditions(filters);

	// "Later in the grid" is smaller for a descending sort, larger for an
	// ascending one; the id settles ties the same way galleryOrderBy does.
	const later = descending
		? sql`(${key} < ${value} OR (${key} = ${value} AND ${images.id} < ${anchor.id}))`
		: sql`(${key} > ${value} OR (${key} = ${value} AND ${images.id} > ${anchor.id}))`;
	const earlier = descending
		? sql`(${key} > ${value} OR (${key} = ${value} AND ${images.id} > ${anchor.id}))`
		: sql`(${key} < ${value} OR (${key} = ${value} AND ${images.id} < ${anchor.id}))`;
	const forward = galleryOrderBy(sort);
	const backward = descending ? [sql`${key} ASC`, asc(images.id)] : [sql`${key} DESC`, desc(images.id)];

	const pick = (where: SQL, order: SQL[]) =>
		db
			.select({ slug: images.slug, title: images.title, imageUrl: images.imageUrl })
			.from(images)
			.leftJoin(artists, eq(images.artistId, artists.id))
			.where(and(...conditions, where))
			.orderBy(...order)
			.limit(1)
			.get();

	const [prev, next] = await Promise.all([pick(earlier, backward), pick(later, forward)]);
	return { prev: prev ?? null, next: next ?? null };
}
