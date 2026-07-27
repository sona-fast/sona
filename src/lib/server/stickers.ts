// Shared sticker domain logic: the view shapes the UI renders, pack-shape
// derivation, the single-artist invariant, and the read queries used by both the
// public /stickers section and the admin list. The write side (Telegram import,
// manual save, delete + storage cleanup) lives in sticker-import.ts.
//
// Pack shape is DERIVED, never stored:
//   managerArtistId set  → single-artist  (every sticker's artistId equals it)
//   managerArtistId null → self-managed   (single or multi by distinct artists)

import { inArray, eq, asc, and, sql, type SQL } from 'drizzle-orm';
import { stickerPacks, stickers, stickerEmojis, artists, characters } from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';

export type PackShape = 'single' | 'multi';

/** Artist as surfaced in credits — id, name, avatar, and every social link. */
export interface ArtistView {
	id: number;
	name: string;
	avatarUrl: string | null;
	twitterUrl: string | null;
	blueskyUrl: string | null;
	telegramUrl: string | null;
	furAffinityUrl: string | null;
	deviantArtUrl: string | null;
	patreonUrl: string | null;
	instagramUrl: string | null;
}

export interface StickerView {
	id: number;
	packId: number;
	imageUrl: string;
	thumbnailUrl: string | null;
	width: number | null;
	height: number | null;
	format: 'png' | 'webp' | 'animated' | 'video';
	position: number;
	nsfw: boolean;
	emojis: string[];
	/** null = unattributed (artist not yet assigned). */
	artist: ArtistView | null;
}

export interface PackSummary {
	id: number;
	name: string;
	slug: string;
	description: string | null;
	coverImageUrl: string | null;
	telegramUrl: string | null;
	source: 'telegram' | 'self-hosted';
	published: boolean;
	createdAt: string;
	character: { id: number; name: string } | null;
	shape: PackShape;
	/** The managing artist, or null when managed by the site owner. */
	manager: ArtistView | null;
	/** For single-artist packs, the one artist to credit ("by {artist}"). */
	soleArtist: ArtistView | null;
	/** Distinct contributing artists (for the multi-artist row). */
	artists: ArtistView[];
	stickerCount: number;
	/** First ≤4 sticker imageUrls (by position, then id) — for the cover mosaic. */
	previewImages: string[];
}

export interface PackDetail extends PackSummary {
	stickers: StickerView[];
}

type ArtistRow = typeof artists.$inferSelect;

function artistView(row: ArtistRow): ArtistView {
	return {
		id: row.id,
		name: row.name,
		avatarUrl: row.avatarUrl,
		twitterUrl: row.twitterUrl,
		blueskyUrl: row.blueskyUrl,
		telegramUrl: row.telegramUrl,
		furAffinityUrl: row.furAffinityUrl,
		deviantArtUrl: row.deviantArtUrl,
		patreonUrl: row.patreonUrl,
		instagramUrl: row.instagramUrl
	};
}

/**
 * Derive a pack's shape. A pack with a managerArtistId is single-artist by
 * definition (the invariant guarantees every sticker shares that artist).
 * Otherwise it's single only if all its stickers happen to share one artist.
 */
export function derivePackShape(managerArtistId: number | null, distinctArtistIds: number[]): PackShape {
	if (managerArtistId != null) return 'single';
	return distinctArtistIds.length <= 1 ? 'single' : 'multi';
}

/**
 * Artist to credit for a sticker APPENDED to an existing unmanaged pack (the
 * cron re-sync path — managed packs never reach here: the call site credits
 * the manager first). STRICT rule: the append inherits an artist only when
 * EVERY existing sticker is credited to that same artist — the input is the
 * pack's distinct artistIds INCLUDING null, so any unattributed sibling (or a
 * mix, or an empty pack) yields null and the sticker is left for manual
 * review. Deliberately stricter than derivePackShape's display notion: #184
 * originally allowed inference past unattributed siblings, but the PR #195
 * review showed that misattributes a collab pack where only the first sticker
 * has been credited so far — misattribution being the worst failure mode for
 * an attribution feature, ambiguity now always wins (decision revised
 * 2026-07-17).
 */
export function inferAppendedArtistId(distinctArtistIds: (number | null)[]): number | null {
	return distinctArtistIds.length === 1 ? distinctArtistIds[0] : null;
}

/**
 * Enforce the single-artist invariant on a set of per-sticker artist ids before
 * insert/update: when a pack has a managerArtistId, every sticker MUST be credited
 * to that artist, so we override any per-sticker value. With no manager, the
 * per-sticker ids stand (a self-managed pack may mix artists). Returns the
 * artistId to persist for each input in order.
 */
export function resolveStickerArtistIds(
	managerArtistId: number | null,
	perStickerArtistIds: (number | null)[]
): (number | null)[] {
	if (managerArtistId != null) return perStickerArtistIds.map(() => managerArtistId);
	return perStickerArtistIds;
}

// D1 caps bound parameters at ~100 per query, so any IN-list built from a
// per-sticker set (a pack can hold 100+ stickers/artists) must be chunked.
const D1_MAX_PARAMS = 90;

function chunk<T>(arr: T[], size = D1_MAX_PARAMS): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

/** Fetch the given artist ids as a Map<id, ArtistView>, chunked to respect D1's param cap. */
async function artistMap(db: Database, ids: number[]): Promise<Map<number, ArtistView>> {
	const unique = [...new Set(ids)].filter((n) => Number.isInteger(n));
	if (unique.length === 0) return new Map();
	const rows = (
		await Promise.all(chunk(unique).map((c) => db.select().from(artists).where(inArray(artists.id, c))))
	).flat();
	return new Map(rows.map((r) => [r.id, artistView(r)]));
}

/**
 * List packs as summaries (cover, character, credit, counts), newest first.
 * `publishedOnly` for the public section; admin passes false to see drafts.
 */
export async function listPacks(
	db: Database,
	{ publishedOnly = true }: { publishedOnly?: boolean } = {}
): Promise<PackSummary[]> {
	const packRows = await db
		.select()
		.from(stickerPacks)
		.where(publishedOnly ? eq(stickerPacks.published, true) : undefined)
		.orderBy(sql`${stickerPacks.createdAt} DESC`);
	if (packRows.length === 0) return [];

	const packIds = packRows.map((p) => p.id);

	// Every packId IN-list below is chunked under D1's bound-param cap: a busy site
	// can list 90+ packs in one view, and D1 counts every placeholder in a query.
	// Chunks are disjoint by packId, so per-chunk grouping/distinct/ordering all
	// hold once flattened (each pack lives in exactly one chunk).

	// Per-pack count + distinct artist ids, in two grouped queries.
	const counts = (
		await Promise.all(
			chunk(packIds).map((c) =>
				db
					.select({ packId: stickers.packId, n: sql<number>`COUNT(*)` })
					.from(stickers)
					.where(inArray(stickers.packId, c))
					.groupBy(stickers.packId)
			)
		)
	).flat();
	const countByPack = new Map(counts.map((c) => [c.packId, c.n]));

	const artistPairs = (
		await Promise.all(
			chunk(packIds).map((c) =>
				db.selectDistinct({ packId: stickers.packId, artistId: stickers.artistId }).from(stickers).where(inArray(stickers.packId, c))
			)
		)
	).flat();

	// First ≤4 stickers per pack for the cover mosaic. No N+1 — one query per packId
	// chunk, sliced to 4/pack in JS. Ordering within a pack survives chunking because
	// a pack is wholly inside one chunk, ordered there by (position, id).
	const previewRows = (
		await Promise.all(
			chunk(packIds).map((c) =>
				db
					.select({ packId: stickers.packId, imageUrl: stickers.imageUrl })
					.from(stickers)
					.where(inArray(stickers.packId, c))
					.orderBy(asc(stickers.packId), asc(stickers.position), asc(stickers.id))
			)
		)
	).flat();
	const previewByPack = new Map<number, string[]>();
	for (const { packId, imageUrl } of previewRows) {
		const list = previewByPack.get(packId) ?? [];
		if (list.length < 4) {
			list.push(imageUrl);
			previewByPack.set(packId, list);
		}
	}
	// artistId may be null (unattributed) — only track real artist ids per pack.
	const artistsByPack = new Map<number, number[]>();
	for (const { packId, artistId } of artistPairs) {
		if (artistId == null) continue;
		const list = artistsByPack.get(packId) ?? [];
		list.push(artistId);
		artistsByPack.set(packId, list);
	}

	const charIds = [...new Set(packRows.map((p) => p.characterId))];
	const charRows = (
		await Promise.all(
			chunk(charIds).map((c) => db.select({ id: characters.id, name: characters.name }).from(characters).where(inArray(characters.id, c)))
		)
	).flat();
	const charById = new Map(charRows.map((c) => [c.id, c]));

	const allArtistIds = [
		...packRows.flatMap((p) => (p.managerArtistId != null ? [p.managerArtistId] : [])),
		...artistPairs.map((a) => a.artistId).filter((id): id is number => id != null)
	];
	const artistById = await artistMap(db, allArtistIds);

	return packRows.map((p) => {
		const distinct = artistsByPack.get(p.id) ?? [];
		const contributing = distinct.map((id) => artistById.get(id)).filter((a): a is ArtistView => !!a);
		const manager = p.managerArtistId != null ? artistById.get(p.managerArtistId) ?? null : null;
		const shape = derivePackShape(p.managerArtistId, distinct);
		return {
			id: p.id,
			name: p.name,
			slug: p.slug,
			description: p.description,
			coverImageUrl: p.coverImageUrl,
			telegramUrl: p.telegramUrl,
			source: p.source,
			published: p.published,
			createdAt: p.createdAt,
			character: charById.get(p.characterId) ?? null,
			shape,
			manager,
			soleArtist: shape === 'single' ? manager ?? contributing[0] ?? null : null,
			artists: contributing,
			stickerCount: countByPack.get(p.id) ?? 0,
			previewImages: previewByPack.get(p.id) ?? []
		};
	});
}

/** A pack summary + its stickers (with emoji + artist), ordered by position. */
export async function getPackBySlug(
	db: Database,
	slug: string,
	{ publishedOnly = true }: { publishedOnly?: boolean } = {}
): Promise<PackDetail | null> {
	const pack = await db.select().from(stickerPacks).where(eq(stickerPacks.slug, slug)).get();
	if (!pack) return null;
	if (publishedOnly && !pack.published) return null;

	const stickerViews = await loadStickerViews(db, [eq(stickers.packId, pack.id)]);

	const char = await db
		.select({ id: characters.id, name: characters.name })
		.from(characters)
		.where(eq(characters.id, pack.characterId))
		.get();

	// Distinct contributing artists, ignoring unattributed (null) stickers.
	const distinct = [...new Set(stickerViews.map((s) => s.artist?.id).filter((id): id is number => id != null))];
	const contributing = distinct
		.map((id) => stickerViews.find((s) => s.artist?.id === id)!.artist)
		.filter((a): a is ArtistView => !!a);
	const manager =
		pack.managerArtistId != null
			? (await artistMap(db, [pack.managerArtistId])).get(pack.managerArtistId) ?? null
			: null;
	const shape = derivePackShape(pack.managerArtistId, distinct);

	return {
		id: pack.id,
		name: pack.name,
		slug: pack.slug,
		description: pack.description,
		coverImageUrl: pack.coverImageUrl,
		telegramUrl: pack.telegramUrl,
		source: pack.source,
		published: pack.published,
		createdAt: pack.createdAt,
		character: char ?? null,
		shape,
		manager,
		soleArtist: shape === 'single' ? manager ?? contributing[0] ?? null : null,
		artists: contributing,
		stickerCount: stickerViews.length,
		previewImages: stickerViews.slice(0, 4).map((s) => s.imageUrl),
		stickers: stickerViews
	};
}

/**
 * Load StickerViews (sticker + emoji[] + artist) matching the given conditions,
 * ordered by position. Shared by pack detail and cross-pack filtered search.
 */
async function loadStickerViews(db: Database, conditions: SQL[]): Promise<StickerView[]> {
	const where = conditions.length > 0 ? and(...conditions) : undefined;
	const rows = await db.select().from(stickers).where(where).orderBy(asc(stickers.position), asc(stickers.id));
	if (rows.length === 0) return [];

	// Fetch emojis via a SUBQUERY on the same condition rather than an IN-list of
	// every sticker id — a pack can hold 100+ stickers, over D1's bound-param cap.
	const emojiRows = await db
		.select()
		.from(stickerEmojis)
		.where(inArray(stickerEmojis.stickerId, db.select({ id: stickers.id }).from(stickers).where(where)));
	const emojisBySticker = new Map<number, string[]>();
	for (const e of emojiRows) {
		const list = emojisBySticker.get(e.stickerId) ?? [];
		list.push(e.emoji);
		emojisBySticker.set(e.stickerId, list);
	}

	const artistById = await artistMap(db, rows.map((r) => r.artistId).filter((id): id is number => id != null));

	return rows.map((r) => ({
		id: r.id,
		packId: r.packId,
		imageUrl: r.imageUrl,
		thumbnailUrl: r.thumbnailUrl,
		width: r.width,
		height: r.height,
		format: r.format,
		position: r.position,
		nsfw: r.nsfw,
		emojis: emojisBySticker.get(r.id) ?? [],
		// null artistId → unattributed sticker.
		artist: r.artistId != null ? artistById.get(r.artistId) ?? null : null
	}));
}

/**
 * Cross-pack sticker search for the filtered landing view. Filters by exact emoji
 * glyphs (caller expands keywords to glyphs via emoji-keywords) and/or artist.
 * Only returns stickers in published packs when publishedOnly.
 */
export async function findStickers(
	db: Database,
	opts: { emojis?: string[]; artistId?: number; publishedOnly?: boolean } = {}
): Promise<StickerView[]> {
	const { emojis, artistId, publishedOnly = true } = opts;

	const baseConditions: SQL[] = [];
	if (publishedOnly) {
		baseConditions.push(
			inArray(
				stickers.packId,
				db.select({ id: stickerPacks.id }).from(stickerPacks).where(eq(stickerPacks.published, true))
			)
		);
	}
	if (artistId) baseConditions.push(eq(stickers.artistId, artistId));

	if (!emojis || emojis.length === 0) return loadStickerViews(db, baseConditions);

	// The glyph set can be huge: a keyword like "face" expands to hundreds of emoji
	// (and "s" to 1000+), so the emoji IN-list must be chunked under D1's bound-param
	// cap. OR-ing chunked subqueries in one query wouldn't help — D1 counts every
	// placeholder in a statement — so we run one query per chunk and UNION the
	// matches in JS, deduped by sticker id (a sticker can carry glyphs from several
	// chunks). Never truncate: missing a chunk would silently drop valid results.
	const byId = new Map<number, StickerView>();
	for (const c of chunk(emojis)) {
		const emojiCond = inArray(
			stickers.id,
			db.select({ id: stickerEmojis.stickerId }).from(stickerEmojis).where(inArray(stickerEmojis.emoji, c))
		);
		for (const s of await loadStickerViews(db, [...baseConditions, emojiCond])) byId.set(s.id, s);
	}
	// Restore the canonical order loadStickerViews guarantees within a chunk: position, then id.
	return [...byId.values()].sort((a, b) => a.position - b.position || a.id - b.id);
}

/**
 * Distinct emojis across published packs, most-used first, for the chip rail.
 * Omit `limit` to get them all (the rail wraps); pass a number to cap.
 */
export async function topEmojis(db: Database, limit?: number): Promise<Array<{ emoji: string; count: number }>> {
	const q = db
		.select({ emoji: stickerEmojis.emoji, count: sql<number>`COUNT(*)` })
		.from(stickerEmojis)
		.where(
			sql`${stickerEmojis.stickerId} IN (SELECT s.id FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE p.published = 1)`
		)
		.groupBy(stickerEmojis.emoji)
		.orderBy(sql`COUNT(*) DESC`);
	return limit != null ? q.limit(limit) : q;
}

/** Artists that have at least one sticker in a published pack — for the artist filter. */
export async function listStickerArtists(db: Database): Promise<Array<{ id: number; name: string }>> {
	return db
		.select({ id: artists.id, name: artists.name })
		.from(artists)
		.where(
			sql`${artists.id} IN (SELECT s.artist_id FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE p.published = 1)`
		)
		.orderBy(artists.name);
}
