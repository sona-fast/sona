// Server half of the passport homepage (landingLayout = 'passport'). Reads the
// counts, conventions and picture, then hands them to the pure stamp assembly
// in $lib/landing/passport. Every D1 read is bounded: a stall degrades the page
// to fewer stamps (or the profile picture), never to a 500 and never to a zero.

import { and, asc, count, countDistinct, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
	characters,
	collections,
	conventions,
	fursuitPhotos,
	imageCharacters,
	images,
	artists,
	stickerPacks,
	stickers,
	vrAvatars
} from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';
import { getMode } from '$lib/server/furtrack';
import { DEFAULTS, type SiteSettings } from '$lib/server/settings';
import { withTimeout } from '$lib/server/timeout';
import { upcomingCutoff } from '$lib/convention-window';
import {
	buildStamps,
	hasAnyStamp,
	machineLine,
	MAX_PAST_STAMPS,
	type PassportCounts,
	type PassportStamps
} from '$lib/landing/passport';
import { LICENSES, type LicenseKey } from '$lib/furtrack/license';
import type { SocialPlatform } from '$lib/social-platforms';

export interface PassportPicture {
	/** piece: the day's piece from the SFW pool (see loadPassportPicture);
	 *  avatar: the admin avatar, which is not a gallery piece. Neither is ever
	 *  NSFW, so the picture needs no blur and is always fit for a link preview. */
	kind: 'piece' | 'avatar';
	imageUrl: string;
	slug: string | null;
	title: string;
	/** null when no artist is on file; the caption reads "Unattributed". */
	artistName: string | null;
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

const DAY_MS = 86_400_000;

/**
 * The day's passport picture, unexecuted, so loadPassport can put it in its
 * db.batch (awaiting it on its own runs it too). At most one row.
 *
 * The pool is every published, SFW parent piece whose tagged characters are
 * none or only owner characters: a piece of someone else's character is not
 * this character's passport photo.
 *
 * The pick: each piece gets a rank from its id and the UTC day number, and the
 * lowest rank wins. The rank depends on nothing else, so every visitor and the
 * link preview see the same piece all day, and a piece published or hidden
 * mid-day changes the pick only when it is the pick or outranks it (a count
 * and an offset would move the pick on every publish). The next day reshuffles
 * the ranks.
 *
 * The rank is a small integer mix (xor with the day, a multiply, a
 * xor-shift, a multiply, all within 31 bits), not a security hash: it only has
 * to scatter the order from day to day. Integer arithmetic only, so SQLite and
 * D1 agree: every product stays under 2^63 (ids under 2^32 times a 31-bit
 * constant), `& 2147483647` is mod 2^31, and SQLite has no xor, so a ^ b is
 * spelled (a | b) - (a & b).
 */
export function loadPassportPicture(db: Database, now: Date) {
	const day = Math.floor(now.getTime() / DAY_MS);
	// The day's own scatter, computed here in exact integers: a 31-bit value
	// from Knuth's multiplicative constant, bound as an integer below.
	const dayMix = Number((BigInt(day) * 2654435761n) & 0x7fffffffn);
	const a = sql`((${images.id} * 1103515245) & 2147483647)`;
	const d = sql`CAST(${dayMix} AS INTEGER)`;
	const x = sql`((${a} | ${d}) - (${a} & ${d}))`;
	const y = sql`((${x} * 1597334677) & 2147483647)`;
	const z = sql`((${y} | (${y} >> 16)) - (${y} & (${y} >> 16)))`;
	const rank = sql`((${z} * 747796405) & 2147483647)`;
	const otherCharacter = sql`EXISTS (SELECT 1 FROM ${imageCharacters} INNER JOIN ${characters} ON ${characters.id} = ${imageCharacters.characterId} WHERE ${imageCharacters.imageId} = ${images.id} AND ${characters.isOwner} = 0)`;
	return db
		.select({
			slug: images.slug,
			imageUrl: images.imageUrl,
			title: images.title,
			artistName: artists.name
		})
		.from(images)
		.leftJoin(artists, eq(artists.id, images.artistId))
		.where(and(publishedParent, eq(images.nsfw, false), sql`NOT ${otherCharacter}`))
		.orderBy(rank, asc(images.id))
		.limit(1);
}

// The gallery's own filter (fursuitPhotoFromRow's license lookup, then
// `license.displayable || !!permissionSource`) in SQL: never count or group a
// photo the fursuit view would not show. An unknown license key is not
// displayable, and an empty permission source is no permission.
const DISPLAYABLE_LICENSES = (Object.keys(LICENSES) as LicenseKey[]).filter((key) => LICENSES[key].displayable);
const shownPhoto = or(
	inArray(fursuitPhotos.license, DISPLAYABLE_LICENSES),
	sql`${fursuitPhotos.permissionSource} <> ''`
);

/** Room in the event-group read for events pastEventStamps drops because a
 *  confirmed convention of that name has not ended. The conventions load in
 *  the parallel batch, so the count is not known when this read starts. The
 *  limit bounds rows per event, not photos, so the slack is cheap: only a site
 *  with more than 50 confirmed unfinished conventions named after photo events
 *  could underfill MAX_PAST_STAMPS. */
const PAST_STAMP_SLACK = 50;

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
	// no feature stamps and the profile picture, which still renders a page.
	const batch = db.batch([
		loadPassportPicture(db, now),
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
	// hides instead of counting zero. Counted and grouped in SQL, so only two
	// small result sets cross the wire however large the library grows: the
	// totals, and one row per event, newest first. The group limit leaves room
	// for pastEventStamps to drop up to PAST_STAMP_SLACK events named after a
	// confirmed convention that has not ended and still fill MAX_PAST_STAMPS.
	// Both in one batch, so they fail together: no counts without stamps.
	// Only a real calendar date counts toward an event's latest day: date()
	// returns NULL for '2025-13-05' and normalises '2026-02-30' to '2026-03-02',
	// so neither round-trips. Otherwise a malformed date that sorts high would
	// become the group's latest (read as undated by calendarDate) and could take
	// a slot from a real event in the ordering and limit below.
	const day = sql`substr(${fursuitPhotos.takenAt}, 1, 10)`;
	const latest = sql<string | null>`max(CASE WHEN date(${day}) = ${day} THEN ${day} END)`;
	const photosRead = furtrackOn
		? withTimeout(
				db.batch([
					db
						.select({ photos: count(), photographers: countDistinct(fursuitPhotos.photographer) })
						.from(fursuitPhotos)
						.where(shownPhoto),
					db
						.select({ event: fursuitPhotos.event, photos: count(), latest })
						.from(fursuitPhotos)
						// trim() drops a NULL event too: NULL <> '' is not true.
						.where(and(shownPhoto, sql`trim(${fursuitPhotos.event}) <> ''`))
						.groupBy(fursuitPhotos.event)
						.orderBy(sql`${latest} desc nulls last`, asc(fursuitPhotos.event))
						.limit(MAX_PAST_STAMPS + PAST_STAMP_SLACK)
				]),
				timeoutMs,
				null
			)
		: Promise.resolve(null);

	const [batchResult, photoResult] = await Promise.all([withTimeout(batch, timeoutMs, null), photosRead]);
	const photoTotals = photoResult?.[0][0];
	const [pieceRows, galleryRows, stickerRows, vrRows, collectionRows, conRows, aboutConRows] = batchResult ?? [
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

	const name = settings.ownerName || settings.siteName;
	let picture: PassportPicture | null = null;
	const piece = pieceRows[0];
	if (piece) {
		// The schema allows an empty title; the character's name keeps the
		// picture link named.
		picture = { kind: 'piece', ...piece, title: piece.title.trim() || name };
	} else if (settings.adminAvatarUrl) {
		picture = {
			kind: 'avatar',
			imageUrl: settings.adminAvatarUrl,
			slug: null,
			title: '',
			artistName: null
		};
	}

	const counts: PassportCounts = {
		pieces: gallery?.pieces ?? null,
		artists: gallery?.artists ?? null,
		photos: photoTotals?.photos ?? null,
		photographers: photoTotals?.photographers ?? null,
		stickers: sticker?.stickers ?? null,
		packs: sticker?.packs ?? null,
		avatars: vrRows[0]?.n ?? null,
		collections: collectionRows[0]?.n ?? null
	};

	const socials = socialsOf(settings);
	const stamps = buildStamps({
		counts,
		conventions: conRows,
		events: photoResult?.[1] ?? [],
		about: {
			links: socials.length > 0,
			conventions: aboutConRows.length > 0
		},
		now
	});

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
