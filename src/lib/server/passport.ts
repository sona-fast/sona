// Server half of the passport homepage (landingLayout = 'passport'). Reads the
// counts, conventions and picture, then hands them to the pure stamp assembly
// in $lib/landing/passport. Every D1 read is bounded: a stall degrades the page
// to fewer stamps (or the profile picture), never to a 500 and never to a zero.

import { and, asc, count, countDistinct, desc, eq, isNull, sql } from 'drizzle-orm';
import {
	collections,
	conventions,
	fursuitPhotos,
	images,
	artists,
	stickerPacks,
	stickers,
	vrAvatars
} from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';
import { refSheetQuery } from '$lib/server/presence';
import { getMode } from '$lib/server/furtrack';
import { DEFAULTS, type SiteSettings } from '$lib/server/settings';
import { withTimeout } from '$lib/server/timeout';
import { upcomingCutoff } from '$lib/convention-window';
import {
	buildStamps,
	hasAnyStamp,
	machineLine,
	type PassportCounts,
	type PassportPhoto,
	type PassportStamps
} from '$lib/landing/passport';
import { LICENSES, type LicenseKey } from '$lib/furtrack/license';
import type { SocialPlatform } from '$lib/social-platforms';

export interface PassportPicture {
	/** ref: the ref sheet; piece: the first featured or newest SFW piece;
	 *  avatar: the admin avatar, which is not a gallery piece. */
	kind: 'ref' | 'piece' | 'avatar';
	imageUrl: string;
	slug: string | null;
	title: string;
	/** null when no artist is on file; the caption reads "Unattributed". */
	artistName: string | null;
	nsfw: boolean;
}

export interface PassportData {
	name: string;
	pronouns: string;
	species: string;
	host: string;
	since: string | null;
	socials: { platform: SocialPlatform; url: string }[];
	/** Empty while aboutText is blank or still the shipped default sentence,
	 *  which reads as a slogan on a character's page. */
	about: string;
	picture: PassportPicture | null;
	mrz: [string, string];
	stamps: PassportStamps;
	hasStamps: boolean;
}

type Env = App.Platform['env'];

/** Social links in the data page's "Elsewhere" row, in /connect's order with
 *  FurTrack (which /connect omits) last. */
function socialsOf(settings: SiteSettings): PassportData['socials'] {
	const all: { platform: SocialPlatform; url: string }[] = [
		{ platform: 'bluesky', url: settings.blueskyUrl },
		{ platform: 'telegram', url: settings.telegramUrl },
		{ platform: 'furaffinity', url: settings.furAffinityUrl },
		{ platform: 'twitter', url: settings.twitterUrl },
		{ platform: 'instagram', url: settings.instagramUrl },
		{ platform: 'furtrack', url: settings.furtrackUrl }
	];
	return all.filter((s) => s.url);
}

const publishedParent = and(eq(images.published, true), isNull(images.parentImageId));

export async function loadPassport(opts: {
	db: Database;
	env: Env | undefined;
	settings: SiteSettings;
	host: string;
	now: Date;
	timeoutMs: number;
}): Promise<PassportData> {
	const { db, env, settings, host, now, timeoutMs } = opts;
	const furtrackOn = getMode(env) !== 'off';

	// Round trip 1: every independent read in one batch. D1 batches are
	// all-or-nothing, so a stall or failure drops the whole set to its fallback:
	// no feature stamps and no ref sheet, which still renders a page.
	const batch = db.batch([
		refSheetQuery(db),
		// Counts include NSFW pieces: a count isn't a picture.
		db
			.select({
				pieces: count(),
				artists: countDistinct(images.artistId),
				since: sql<string | null>`MIN(substr(NULLIF(${images.commissionedAt}, ''), 1, 4))`
			})
			.from(images)
			.where(publishedParent),
		db
			.select({
				packs: count(),
				stickers: sql<number>`(SELECT COUNT(*) FROM ${stickers} INNER JOIN ${stickerPacks} p ON p.id = ${stickers.packId} WHERE p.published = 1)`
			})
			.from(stickerPacks)
			.where(eq(stickerPacks.published, true)),
		// published = 1 matches the /vr page's own list.
		db.select({ n: count() }).from(vrAvatars).where(eq(vrAvatars.published, true)),
		// Every collection row, matching the collections nav probe and page, which
		// list a collection even when all its images are unpublished.
		db.select({ n: count() }).from(collections),
		// Upcoming and live confirmed rows only; past stamps come from the fursuit
		// photos (see pastEventStamps). The day of slack is /connect's: a con still
		// running further west survives the UTC filter and isLiveNow/hasEnded judge
		// it in its own zone.
		db
			.select({
				id: conventions.id,
				name: conventions.name,
				location: conventions.location,
				startDate: conventions.startDate,
				endDate: conventions.endDate,
				timezone: conventions.timezone,
				status: conventions.status
			})
			.from(conventions)
			.where(
				and(
					eq(conventions.status, 'confirmed'),
					sql`COALESCE(${conventions.endDate}, ${conventions.startDate}) >= ${upcomingCutoff(now)}`
				)
			)
			.orderBy(asc(conventions.startDate)),
		// Whether /about lists any convention: it shows upcoming rows of every
		// status against today's UTC date, so this uses its predicate, not the
		// confirmed-only one above. Existence only, for the About stamp.
		db
			.select({ id: conventions.id })
			.from(conventions)
			.where(sql`COALESCE(${conventions.endDate}, ${conventions.startDate}) >= ${now.toISOString().slice(0, 10)}`)
			.limit(1)
	]);

	// Fursuit photos only while FurTrack is on, the same gate as the gallery's
	// fursuit view. Independent of the batch, so it runs alongside it rather
	// than adding a round trip. null (not []) on a stall, so the fursuit stamp
	// hides instead of counting zero. Only the columns the counts, the event
	// stamps and the displayable filter read; no row limit, because the counts
	// need every row, and no order, because the stamps sort by date themselves.
	// Every row crosses the wire, which is fine at personal-library sizes; if
	// libraries grow into the thousands, the next step is counting and grouping
	// by event in SQL (GROUP BY) with the license filter moved into the query.
	const photosRead: Promise<(PassportPhoto & { photographer: string })[] | null> = furtrackOn
		? withTimeout(
				db
					.select({
						event: fursuitPhotos.event,
						takenAt: fursuitPhotos.takenAt,
						photographer: fursuitPhotos.photographer,
						license: fursuitPhotos.license,
						permissionSource: fursuitPhotos.permissionSource
					})
					.from(fursuitPhotos)
					.then((rows) =>
						rows
							// The gallery's own filter (fursuitPhotoFromRow's license lookup):
							// never count or group a photo the fursuit view would not show.
							.filter(
								(r) =>
									(LICENSES[r.license as LicenseKey] ?? LICENSES.unknown).displayable || !!r.permissionSource
							)
							.map((r) => ({
								event: r.event ?? undefined,
								takenAt: r.takenAt ?? undefined,
								photographer: r.photographer
							}))
					),
				timeoutMs,
				null
			)
		: Promise.resolve(null);

	const [batchResult, photos] = await Promise.all([withTimeout(batch, timeoutMs, null), photosRead]);
	const [refRows, galleryRows, stickerRows, vrRows, collectionRows, conRows, aboutConRows] = batchResult ?? [
		[],
		[],
		[],
		[],
		[],
		[],
		[]
	];
	const gallery = galleryRows[0];
	const sticker = stickerRows[0];

	let picture: PassportPicture | null = null;
	const ref = refRows[0];
	if (ref) {
		// Field by field: the query's width and height are /art's, and the passport
		// sizes its frame by aspect ratio, so they stay out of the page payload.
		picture = {
			kind: 'ref',
			slug: ref.slug,
			imageUrl: ref.imageUrl,
			title: ref.title,
			artistName: ref.artistName,
			nsfw: ref.nsfw
		};
	} else if (batchResult) {
		// Round trip 2, only without a ref sheet: the first featured piece, else
		// the newest SFW parent. Featured pieces are SFW by construction; the
		// nsfw filter keeps both halves of the fallback safe to show unblurred.
		// Skipped when round trip 1 already failed: D1 is struggling, and the
		// profile picture is a fine page.
		const piece = await withTimeout(
			db
				.select({
					slug: images.slug,
					imageUrl: images.imageUrl,
					title: images.title,
					artistName: artists.name
				})
				.from(images)
				.leftJoin(artists, eq(artists.id, images.artistId))
				.where(and(publishedParent, eq(images.nsfw, false)))
				.orderBy(
					desc(images.featured),
					// featured_order only ranks featured pieces: an unfeatured piece can
					// keep a stale order from when it was featured.
					sql`CASE WHEN ${images.featured} = 1 THEN ${images.featuredOrder} END asc nulls last`,
					desc(images.createdAt),
					desc(images.id)
				)
				.limit(1)
				.then((rows) => rows[0] ?? null),
			timeoutMs,
			null
		);
		if (piece) picture = { kind: 'piece', ...piece, nsfw: false };
	}
	if (!picture && settings.adminAvatarUrl) {
		picture = {
			kind: 'avatar',
			imageUrl: settings.adminAvatarUrl,
			slug: null,
			title: '',
			artistName: null,
			nsfw: false
		};
	}

	const counts: PassportCounts = {
		pieces: gallery?.pieces ?? null,
		artists: gallery?.artists ?? null,
		photos: photos ? photos.length : null,
		photographers: photos ? new Set(photos.map((p) => p.photographer)).size : null,
		stickers: sticker?.stickers ?? null,
		packs: sticker?.packs ?? null,
		avatars: vrRows[0]?.n ?? null,
		collections: collectionRows[0]?.n ?? null
	};

	const socials = socialsOf(settings);
	const stamps = buildStamps({
		counts,
		conventions: conRows,
		photos: photos ?? [],
		about: {
			links: socials.length > 0,
			conventions: aboutConRows.length > 0
		},
		now
	});

	const name = settings.ownerName || settings.siteName;
	const since = gallery?.since && /^\d{4}$/.test(gallery.since) ? gallery.since : null;
	const about = settings.aboutText.trim() === DEFAULTS.aboutText ? '' : settings.aboutText.trim();

	return {
		name,
		pronouns: settings.pronouns,
		species: settings.sonaSpecies,
		host,
		since,
		socials,
		about,
		picture,
		mrz: machineLine({ host, name, species: settings.sonaSpecies, pronouns: settings.pronouns, since }),
		stamps,
		hasStamps: hasAnyStamp(stamps)
	};
}
