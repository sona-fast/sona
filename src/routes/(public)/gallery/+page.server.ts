import { getDb } from '$lib/server/db';
import { images, artists, imageTags, tags, characters, fursuitPhotos as fursuitPhotosTable } from '$lib/server/db/schema';
import { eq, desc, asc, like, sql, and, inArray, type SQL } from 'drizzle-orm';
import { fursuitPhotoFromRow } from '$lib/server/fursuit-import';
import { getMode } from '$lib/server/furtrack';
import { withTimeout } from '$lib/server/timeout';
import type { FursuitPhoto } from '$lib/furtrack/types';
import type { PageServerLoad } from './$types';

// The gallery makes several sequential D1 reads; under a latency spike that can
// stack past the edge timeout. Bound the whole data fetch and degrade to an
// empty gallery (fast 200) rather than a 524.
const GALLERY_TIMEOUT_MS = 9000;

export const load: PageServerLoad = async ({ platform, url }) => {
	const db = getDb(platform!.env.DB);

	const search = url.searchParams.get('q') || '';
	const tagFilter = url.searchParams.get('tag') || '';
	const artistFilter = url.searchParams.get('artist') || '';
	const characterFilter = url.searchParams.get('character') || '';
	const sort = url.searchParams.get('sort') || 'newest';
	const page = Math.max(1, Number(url.searchParams.get('page') || 1));
	const perPage = 20;
	const photographerFilter = url.searchParams.get('photographer') || '';
	const eventFilter = url.searchParams.get('event') || '';

	const filters = { search, tag: tagFilter, artist: artistFilter, character: characterFilter, sort };
	const fursuitFilters = { photographer: photographerFilter, event: eventFilter };

	// Degraded result served if D1 is too slow — an empty gallery that still
	// renders the page shell and the user's active filters.
	const degraded = {
		view: 'artwork' as const,
		fursuitEnabled: false,
		fursuitPhotos: [] as FursuitPhoto[],
		fursuitPhotographers: [] as string[],
		fursuitEvents: [] as string[],
		fursuitCapped: false,
		fursuitFilters,
		images: [] as Array<Record<string, unknown>>,
		total: 0,
		page,
		totalPages: 0,
		tags: [] as Array<{ name: string }>,
		artists: [] as Array<{ name: string }>,
		characters: [] as Array<{ name: string }>,
		filters,
		degraded: true
	};

	const build = async () => {
		// Build where conditions
		const conditions: SQL[] = [eq(images.published, true)];
		if (search) {
			conditions.push(like(images.title, `%${search}%`));
		}
		if (artistFilter) {
			conditions.push(eq(artists.name, artistFilter));
		}
		if (tagFilter) {
			conditions.push(
				sql`${images.id} IN (SELECT image_id FROM image_tags INNER JOIN tags ON tags.id = image_tags.tag_id WHERE tags.name = ${tagFilter})`
			);
		}
		if (characterFilter) {
			conditions.push(
				sql`${images.id} IN (SELECT image_id FROM image_characters INNER JOIN characters ON characters.id = image_characters.character_id WHERE characters.name = ${characterFilter})`
			);
		}

		const whereClause = and(...conditions);
		const commissionedSortKey = sql`COALESCE(${images.commissionedAt}, ${images.createdAt})`;
		const orderBy =
			sort === 'oldest'
				? asc(images.createdAt)
				: sort === 'commissioned-newest'
				? sql`${commissionedSortKey} DESC`
				: sort === 'commissioned-oldest'
				? sql`${commissionedSortKey} ASC`
				: desc(images.createdAt);

		const allImages = await db
			.select({
				id: images.id,
				title: images.title,
				slug: images.slug,
				imageUrl: images.imageUrl,
				thumbnailUrl: images.thumbnailUrl,
				nsfw: images.nsfw,
				commissionedAt: images.commissionedAt,
				createdAt: images.createdAt,
				artistName: artists.name
			})
			.from(images)
			.leftJoin(artists, eq(images.artistId, artists.id))
			.where(whereClause)
			.orderBy(orderBy)
			.limit(perPage)
			.offset((page - 1) * perPage);

		const totalResult = await db
			.select({ count: sql<number>`COUNT(*)` })
			.from(images)
			.where(whereClause)
			.leftJoin(artists, eq(images.artistId, artists.id))
			.get();
		const total = totalResult?.count || 0;

		// Get first tag per image
		let firstTagByImage: Record<number, string> = {};
		if (allImages.length > 0) {
			// Scope to just this page's images, not the whole image_tags table.
			const allImageTags = await db
				.select({ imageId: imageTags.imageId, tagName: tags.name })
				.from(imageTags)
				.innerJoin(tags, eq(imageTags.tagId, tags.id))
				.where(inArray(imageTags.imageId, allImages.map((img) => img.id)));

			for (const it of allImageTags) {
				if (!firstTagByImage[it.imageId]) {
					firstTagByImage[it.imageId] = it.tagName;
				}
			}
		}

		const imagesWithTags = allImages.map((img) => ({
			...img,
			tag: firstTagByImage[img.id] || undefined
		}));

		// Get all tags, artists, and characters for filters
		const [allTags, allArtists, allCharacters] = await Promise.all([
			db.select({ name: tags.name }).from(tags).orderBy(tags.name),
			db.select({ name: artists.name }).from(artists).orderBy(artists.name),
			db.select({ name: characters.name }).from(characters).orderBy(characters.name)
		]);

		// Fursuit Photos tab (FurTrack). Only active when the feature is enabled; the
		// Fursuit Photos tab — reads imported, self-hosted photos from the DB. No
		// FurTrack calls at request time; the toggle shows when photos exist.
		// Gate on the FurTrack feature flag, not just the data: with mode 'off' the
		// fursuit tab (and any already-imported photos) stay hidden until the feature
		// is turned on, even if rows exist in the table.
		const fursuitCount = (await db.select({ n: sql<number>`COUNT(*)` }).from(fursuitPhotosTable).get())?.n ?? 0;
		const fursuitEnabled = getMode(platform!.env) !== 'off' && fursuitCount > 0;
		const view = fursuitEnabled && url.searchParams.get('view') === 'fursuit' ? 'fursuit' : 'artwork';

		let fursuitPhotos: FursuitPhoto[] = [];
		let fursuitPhotographers: string[] = [];
		let fursuitEvents: string[] = [];
		if (view === 'fursuit') {
			const rows = await db.select().from(fursuitPhotosTable).orderBy(desc(fursuitPhotosTable.createdAt));
			// Defense-in-depth: import only stores displayable photos, but a later
			// license reclassification (license.ts) could turn a stored row
			// non-displayable — never surface one publicly. Filter at the source so
			// the grid AND the filter dropdowns only ever reflect displayable photos.
			const all = rows.map(fursuitPhotoFromRow).filter((p) => p.license.displayable || !!p.permissionSource);
			// Build filter options from the full set, then narrow by the active filters.
			fursuitPhotographers = [...new Set(all.map((p) => p.photographer))].sort();
			fursuitEvents = [...new Set(all.map((p) => p.event).filter((e): e is string => !!e))].sort();
			fursuitPhotos = all.filter(
				(p) =>
					(!photographerFilter || p.photographer === photographerFilter) &&
					(!eventFilter || p.event === eventFilter)
			);
		}

		return {
			view,
			fursuitEnabled,
			fursuitPhotos,
			fursuitPhotographers,
			fursuitEvents,
			fursuitCapped: false,
			fursuitFilters,
			images: imagesWithTags,
			total,
			page,
			totalPages: Math.ceil(total / perPage),
			tags: allTags,
			artists: allArtists,
			characters: allCharacters,
			filters,
			degraded: false
		};
	};

	return withTimeout(build(), GALLERY_TIMEOUT_MS, degraded as Awaited<ReturnType<typeof build>>);
};
