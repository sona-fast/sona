import { and, asc, desc, eq, isNull, like, sql, type SQL } from 'drizzle-orm';
import { artists, images } from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';
import type { GalleryFilters, GallerySort } from '$lib/gallery';

// The gallery grid's filter and order, in one place, so the grid
// ((public)/gallery/+page.server.ts) and the detail page's previous/next
// links ((public)/gallery/[slug]) can't disagree about which piece comes next
// (SONA-179). The same goes for a collection's grid
// ((public)/collections/[slug]) and a piece opened from it.

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
	return orderIn(key, !descending);
}

/** The sort key, then the id as tiebreaker, both in one direction. */
function orderIn(key: SQL, ascending: boolean): SQL[] {
	return ascending ? [sql`${key} ASC`, asc(images.id)] : [sql`${key} DESC`, desc(images.id)];
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
	anchor: NeighborAnchor
): Promise<GalleryNeighbors> {
	return neighborsWhere(db, galleryConditions(filters), sort, anchor);
}

/**
 * WHERE conditions for a collection's grid ((public)/collections/[slug]):
 * its published, non-variant pieces. No other visibility rule applies there;
 * NSFW pieces are listed and blurred by the card.
 */
export function collectionConditions(collectionId: number): SQL[] {
	return [eq(images.collectionId, collectionId), eq(images.published, true), isNull(images.parentImageId)];
}

// A collection lists newest upload first, with no sort picker of its own.
const COLLECTION_SORT: GallerySort = 'newest';

/** ORDER BY for a collection's grid: newest first, the id settling ties. */
export function collectionOrderBy(): SQL[] {
	return galleryOrderBy(COLLECTION_SORT);
}

/**
 * The collection's pieces either side of `anchor`, in the order the
 * collection page lays them out. Null at either end. The caller checks that
 * `anchor` belongs to the collection; this only walks the order.
 */
export async function collectionNeighbors(
	db: Database,
	collectionId: number,
	anchor: NeighborAnchor
): Promise<GalleryNeighbors> {
	return neighborsWhere(db, collectionConditions(collectionId), COLLECTION_SORT, anchor);
}

/** The grid piece a detail page pages from, with the dates the sorts read. */
export interface NeighborAnchor {
	id: number;
	createdAt: string;
	commissionedAt: string | null;
}

export interface GalleryNeighbors {
	prev: GalleryNeighbor | null;
	next: GalleryNeighbor | null;
}

async function neighborsWhere(
	db: Database,
	conditions: SQL[],
	sort: GallerySort,
	anchor: NeighborAnchor
): Promise<GalleryNeighbors> {
	const { key, descending } = sortSpec(sort);
	const value = sort.startsWith('commissioned-') ? (anchor.commissionedAt ?? anchor.createdAt) : anchor.createdAt;

	// The nearest piece past the anchor walking the order one way: rows with a
	// larger (ascending) or smaller key, the id settling ties the same way
	// galleryOrderBy does. "Next in the grid" walks the grid's own direction,
	// "previous" the opposite one.
	const pick = (ascending: boolean) => {
		const op = sql.raw(ascending ? '>' : '<');
		return db
			.select({ slug: images.slug, title: images.title, imageUrl: images.imageUrl })
			.from(images)
			.leftJoin(artists, eq(images.artistId, artists.id))
			.where(
				and(
					...conditions,
					sql`(${key} ${op} ${value} OR (${key} = ${value} AND ${images.id} ${op} ${anchor.id}))`
				)
			)
			.orderBy(...orderIn(key, ascending))
			.limit(1)
			.get();
	};

	const [prev, next] = await Promise.all([pick(descending), pick(!descending)]);
	return { prev: prev ?? null, next: next ?? null };
}
