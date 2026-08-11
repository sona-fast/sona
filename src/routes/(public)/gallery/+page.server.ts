import { getReadDb } from '$lib/server/db';
import { images, artists, imageTags, tags, fursuitPhotos as fursuitPhotosTable } from '$lib/server/db/schema';
import { vrTabEnabled } from '$lib/server/vr-gate';
import { stickerTabEnabled } from '$lib/server/stickers';
import { eq, desc, asc, like, sql, and, inArray, isNull, type SQL } from 'drizzle-orm';
import { listPublicCharacterNames } from '$lib/server/characters';
import { fursuitPhotoFromRow } from '$lib/server/fursuit-import';
import { getMode } from '$lib/server/furtrack';
import { parseAliases } from '$lib/server/registry';
import { getSettings } from '$lib/server/settings';
import { resolveGallerySort } from '$lib/gallery';
import { withTimeout } from '$lib/server/timeout';
import type { FursuitPhoto } from '$lib/furtrack/types';
import type { PageServerLoad } from './$types';

// The gallery makes several sequential D1 reads; under a latency spike that can
// stack past the edge timeout. Bound the whole data fetch and degrade to an
// empty gallery (fast 200) rather than a 524.
const GALLERY_TIMEOUT_MS = 9000;

export const load: PageServerLoad = async ({ platform, url }) => {
	// read replica (eventually consistent); admin writes use the primary
	const db = getReadDb(platform!.env.DB);

	const search = url.searchParams.get('q') || '';
	const tagFilter = url.searchParams.get('tag') || '';
	const artistFilter = url.searchParams.get('artist') || '';
	const characterFilter = url.searchParams.get('character') || '';
	// An explicit ?sort= wins (keeps shared links stable); otherwise fall back to
	// the site's configured default gallery sort.
	const settings = await getSettings(db);
	const sort = resolveGallerySort(url.searchParams.get('sort'), settings.galleryDefaultSort);
	const page = Math.max(1, Number(url.searchParams.get('page') || 1));
	const perPage = 20;
	const photographerFilter = url.searchParams.get('photographer') || '';
	const eventFilter = url.searchParams.get('event') || '';

	const filters = { search, tag: tagFilter, artist: artistFilter, character: characterFilter, sort };
	const fursuitFilters = { photographer: photographerFilter, event: eventFilter };

	// The VR/Stickers pill probes run OUTSIDE the gallery cap (started here, so
	// they overlap build()'s reads): cheap cached SELECT-1s, each fail-open like
	// the nav's, so even the degraded fallback below keeps the REAL tab bar of a
	// healthy-content fork — the .tabs suppression then only fires on genuine
	// zero-content forks. fursuitEnabled has no bounded probe of its own (its
	// COUNT rides build()), so the degraded shape keeps it fail-closed.
	const navProbes = Promise.all([
		withTimeout(vrTabEnabled(db), GALLERY_TIMEOUT_MS, true),
		withTimeout(stickerTabEnabled(db), GALLERY_TIMEOUT_MS, true)
	]);

	const build = async () => {
		// Load artists (with former names) up front — used both to resolve the artist
		// filter and to build the combobox options below. Restrict to artists who have
		// at least one image that actually shows in the grid (published, non-variant —
		// mirrors the card predicate below): unpublished-only, sticker-only, and
		// imported-but-unused artists would otherwise be offered as options that can
		// only ever yield an empty grid. Alias resolution narrows with it — resolving a
		// former name to an artist with no live work would land on an empty grid too.
		const allArtistsRaw = await db
			.select({ name: artists.name, aliases: artists.aliases })
			.from(artists)
			.where(
				sql`EXISTS (SELECT 1 FROM images WHERE images.artist_id = ${artists.id} AND images.published = 1 AND images.parent_image_id IS NULL)`
			)
			.orderBy(artists.name);

		// Resolve the artist filter: a ?artist=X that isn't a current name may be a
		// former name — point it at the artist who now goes by something else, and
		// flag it so the page can show the "formerly" pointer.
		let effectiveArtist = artistFilter;
		let formerName: { searched: string; current: string } | null = null;
		if (artistFilter) {
			const q = artistFilter.toLowerCase();
			// A live current name needs no resolution — go straight to the grid and
			// skip the extra unfiltered read on this hot path.
			if (!allArtistsRaw.some((a) => a.name.toLowerCase() === q)) {
				// The "is this a current name?" check runs against the UNFILTERED artist
				// set, on purpose: a real current name must never be hijacked into
				// former-name resolution (and shown under a false "formerly" banner) just
				// because that artist has no live work. The combobox options and the
				// alias-candidate set below stay LIVE-ONLY (allArtistsRaw).
				const allNames = await db.select({ name: artists.name }).from(artists);
				if (!allNames.some((a) => a.name.toLowerCase() === q)) {
					// Only resolve when EXACTLY ONE live artist claims this former name — an
					// ambiguous former name must not silently credit the wrong artist.
					const viaAlias = allArtistsRaw.filter((a) =>
						parseAliases(a.aliases).some((al) => al.displayName.toLowerCase() === q)
					);
					if (viaAlias.length === 1) {
						effectiveArtist = viaAlias[0].name;
						formerName = { searched: artistFilter, current: viaAlias[0].name };
					}
				}
			}
		}

		// Build where conditions
		// Variants never appear as standalone gallery cards — only their parent does.
		const conditions: SQL[] = [eq(images.published, true), isNull(images.parentImageId)];
		if (search) {
			conditions.push(like(images.title, `%${search}%`));
		}
		if (effectiveArtist) {
			conditions.push(eq(artists.name, effectiveArtist));
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

		// Get all tags and characters for filters (artists already loaded above).
		// Owner/site characters are excluded from the public character filter — see
		// listPublicCharacterNames.
		// VR Avatars and Stickers tabs reuse the navProbes started before this
		// build (shared vrTabEnabled / stickerTabEnabled probes): each is only
		// rendered once at least one published row exists — with zero, the tab
		// stays out of the bar while the section URL keeps rendering its honest
		// empty state.
		const [allTags, allCharacters] = await Promise.all([
			db.select({ name: tags.name }).from(tags).orderBy(tags.name),
			listPublicCharacterNames(db)
		]);
		const [vrEnabled, stickersEnabled] = await navProbes;

		// Carry each artist's former names so the combobox can offer an old name
		// ("Kestrel · formerly KesForge") and stay reachable in-app.
		const allArtists = allArtistsRaw.map((a) => {
			const formerly = parseAliases(a.aliases).map((al) => al.displayName);
			return formerly.length ? { name: a.name, formerly } : { name: a.name };
		});

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
			vrEnabled,
			stickersEnabled,
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
			// The active pill/input shows the current name, even when arrived via a
			// former name (the pointer banner explains the redirect).
			filters: { ...filters, artist: effectiveArtist },
			formerName,
			degraded: false
		};
	};

	const built = await withTimeout(
		build(),
		GALLERY_TIMEOUT_MS,
		null as Awaited<ReturnType<typeof build>> | null
	);
	if (built) return built;

	// Degraded result served if D1 is too slow — an empty gallery that still
	// renders the page shell, the user's active filters, and (via the bounded
	// navProbes above) the real content-gated pills.
	const [vrEnabled, stickersEnabled] = await navProbes;
	return {
		view: 'artwork' as const,
		fursuitEnabled: false,
		stickersEnabled,
		vrEnabled,
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
		artists: [] as Array<{ name: string; formerly?: string[] }>,
		characters: [] as Array<{ name: string }>,
		filters,
		formerName: null as { searched: string; current: string } | null,
		degraded: true
	} as Awaited<ReturnType<typeof build>>;
};
