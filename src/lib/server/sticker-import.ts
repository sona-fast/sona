// Server-only: import a sticker pack from Telegram or save a manually-uploaded
// one, then self-host the sticker images. All write operations go through here;
// reads live in stickers.ts.
//
// Animated (.tgs) handling: Telegram sends gzipped Lottie JSON files. We
// decompress them server-side using DecompressionStream('gzip') (available in
// the Workers/Cloudflare runtime) and store the plain JSON, setting
// format='animated' and pointing imageUrl at the .json file. Video (.webm)
// stickers are stored as-is. Static stickers keep their raster format.

import { eq, asc, sql, and, isNotNull } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { stickerPacks, stickers, stickerEmojis, artists, characters } from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';
import type { SiteSettings } from '$lib/server/settings';
import { getStorage, isAllowedStickerType, extFromContentType, deleteFile, isOwnedUrl } from '$lib/server/storage';
import { getStickerSet, downloadFile, stickerSetUrl, parseStickerSetName, stickerMediaType } from '$lib/server/telegram';
import type { TelegramSticker } from '$lib/server/telegram';
import { resolveStickerArtistIds, inferAppendedArtistId, clearStickerTabCache } from '$lib/server/stickers';
import type { AvatarRehostContext } from '$lib/server/avatar';
import { slugify } from '$lib/server/slugify';
import { isAnimatedRaster, sniffAnimatedFromUrl } from '$lib/server/animated-raster';
import { isRasterFormat } from '$lib/sticker-download';
import { mapWithConcurrency } from '$lib/server/concurrency';
import { sanitizeUrl } from '$lib/server/validate';

type Env = App.Platform['env'];

/** Per-sticker admin overrides from the review grid. */
export interface PerStickerInput {
	excluded?: boolean;
	emojis?: string[];
	artistId?: number;
	nsfw?: boolean;
}

/** Result for one sticker in an import run. */
export interface StickerImportItem {
	fileUniqueId: string;
	index: number;
	status: 'imported' | 'skipped' | 'failed';
	error?: string;
	/** Emoji + fileId so the review/success UI can show WHICH sticker (and preview it). */
	emoji?: string | null;
	fileId?: string;
}

export interface ImportResult {
	imported: number;
	skipped: number;
	failed: number;
	items: StickerImportItem[];
}

/** Current stored metadata for a sticker already in this set's pack — seeds the
 * re-sync grid (so its NSFW/artist/emoji inputs show the real current state) and is
 * the target for in-place metadata updates. */
export interface ExistingStickerMeta {
	id: number;
	nsfw: boolean;
	artistId: number | null;
	emojis: string[];
}

/**
 * A sticker annotated with auto-detected information for the review UI —
 * returned by getImportCandidates WITHOUT importing anything.
 */
export interface StickerCandidate extends TelegramSticker {
	/** Index in the set (0-based), stable for perSticker lookup. */
	index: number;
	/** True when this sticker is already in THIS set's pack (so the grid marks it
	 * "imported", seeds from its stored metadata, and re-syncs it via the update path
	 * instead of re-downloading). */
	alreadyImported: boolean;
	/** Stored metadata when alreadyImported, else null (a new sticker). */
	existing: ExistingStickerMeta | null;
}

/**
 * The set of telegram_file_unique_id values already stored, for import dedupe.
 * Selects the whole column (no WHERE/IN) so it never hits D1's ~100 bound-param
 * cap — a Telegram set can have hundreds of stickers. Bounded by total stored
 * stickers, which is fine at this scale.
 */
async function existingFileUniqueIds(db: Database): Promise<Set<string>> {
	const rows = await db.select({ id: stickers.telegramFileUniqueId }).from(stickers);
	return new Set(rows.map((r) => r.id).filter(Boolean) as string[]);
}

/**
 * Map a pack's stickers by telegram_file_unique_id → their current metadata (id,
 * nsfw, artistId, emojis). Used to seed the re-sync grid and to drive in-place
 * updates of already-imported stickers. Emojis are fetched in one join scoped to the
 * pack (no IN-list, so it can't hit D1's ~100 bound-param cap on a large pack).
 */
async function packStickerMeta(db: Database, packId: number): Promise<Map<string, ExistingStickerMeta>> {
	const rows = await db
		.select({ id: stickers.id, fuid: stickers.telegramFileUniqueId, nsfw: stickers.nsfw, artistId: stickers.artistId })
		.from(stickers)
		.where(eq(stickers.packId, packId));
	const emojiRows = await db
		.select({ stickerId: stickerEmojis.stickerId, emoji: stickerEmojis.emoji })
		.from(stickerEmojis)
		.innerJoin(stickers, eq(stickerEmojis.stickerId, stickers.id))
		.where(eq(stickers.packId, packId));
	const emojisById = new Map<number, string[]>();
	for (const e of emojiRows) {
		const list = emojisById.get(e.stickerId) ?? [];
		list.push(e.emoji);
		emojisById.set(e.stickerId, list);
	}
	const map = new Map<string, ExistingStickerMeta>();
	for (const r of rows) {
		if (!r.fuid) continue;
		map.set(r.fuid, { id: r.id, nsfw: r.nsfw, artistId: r.artistId, emojis: emojisById.get(r.id) ?? [] });
	}
	return map;
}

/** Resolve the pack for a Telegram set name (keyed by its t.me URL), if it exists. */
async function packForSet(db: Database, setName: string): Promise<{ id: number; slug: string } | undefined> {
	return db
		.select({ id: stickerPacks.id, slug: stickerPacks.slug })
		.from(stickerPacks)
		.where(eq(stickerPacks.telegramUrl, stickerSetUrl(setName)))
		.get();
}

/**
 * Return `base`, or the first of `base-2`, `base-3`, … not already used as a pack
 * slug. slugify() already appends a random suffix so a clash is rare, but two packs
 * whose titles slugify to the same base (or a manual pack reusing a name) still can —
 * this makes the fallback a deterministic numeric suffix instead of failing the insert
 * on the UNIQUE slug constraint.
 */
async function uniqueSlug(db: Database, base: string): Promise<string> {
	let candidate = base;
	for (let n = 2; ; n++) {
		const taken = await db.select({ id: stickerPacks.id }).from(stickerPacks).where(eq(stickerPacks.slug, candidate)).get();
		if (!taken) return candidate;
		candidate = `${base}-${n}`;
	}
}

/**
 * Get the pack for a Telegram set (keyed by its t.me URL), creating it if absent.
 * `created` is true only when THIS call inserted the row; a caller uses it to decide
 * whether to append (continue positions after the current max) and whether to drop
 * the pack if the whole import fails.
 *
 * The create INSERT derives a collision-free slug up front (uniqueSlug appends a
 * deterministic -2/-3 suffix when the base is already taken by a DIFFERENT set), so a
 * slug clash no longer fails the import. onConflictDoNothing + re-SELECT still handle
 * the remaining race where a concurrent import grabbed the slug between the check and
 * the insert.
 *
 * NOTE: because slugs are randomly suffixed, two simultaneous imports of the SAME set
 * compute DIFFERENT slugs and so BOTH inserts succeed — this does NOT dedupe the pack
 * itself (you can still get two packs for one telegramUrl). Fully closing that needs a
 * UNIQUE key on telegram_url (which packForSet already assumes) — deliberately left as
 * a follow-up; here we only make the slug-collision path fail cleanly and keep the
 * re-SELECT-by-telegramUrl as the authoritative "append to existing" branch.
 */
async function getOrCreatePack(
	db: Database,
	opts: { telegramUrl: string; title: string; characterId: number; managerArtistId: number | null }
): Promise<{ packId: number; packSlug: string; created: boolean }> {
	const existing = await db
		.select({ id: stickerPacks.id, slug: stickerPacks.slug })
		.from(stickerPacks)
		.where(eq(stickerPacks.telegramUrl, opts.telegramUrl))
		.get();
	if (existing) return { packId: existing.id, packSlug: existing.slug, created: false };

	const slug = await uniqueSlug(db, slugify(opts.title));
	const inserted = await db
		.insert(stickerPacks)
		.values({
			name: opts.title,
			slug,
			characterId: opts.characterId,
			managerArtistId: opts.managerArtistId,
			telegramUrl: opts.telegramUrl,
			source: 'telegram',
			published: false
		})
		.onConflictDoNothing()
		.returning({ id: stickerPacks.id });
	if (inserted.length > 0) return { packId: inserted[0].id, packSlug: slug, created: true };

	// Insert no-op'd on the UNIQUE slug. Re-select this set's pack in case a concurrent
	// import of the SAME set created it (matching telegramUrl) and append to that.
	const raced = await db
		.select({ id: stickerPacks.id, slug: stickerPacks.slug })
		.from(stickerPacks)
		.where(eq(stickerPacks.telegramUrl, opts.telegramUrl))
		.get();
	if (raced) return { packId: raced.id, packSlug: raced.slug, created: false };

	// No pack with this telegramUrl, yet our (checked-free) slug was taken between
	// uniqueSlug and this insert — a rare TOCTOU race with a concurrent import of a
	// DIFFERENT set. Surface it clearly (the caller can retry) instead of letting the
	// raw constraint error escape.
	throw new Error(`sticker pack slug "${slug}" is already taken by a different set`);
}

/**
 * Fetch a sticker set and annotate each sticker with import state.
 * Returns null when Telegram is not configured or the set is unreachable.
 */
export async function getImportCandidates(opts: {
	env: Env | undefined;
	db: Database;
	nameOrUrl: string;
}): Promise<{ setName: string; title: string; candidates: StickerCandidate[] } | null> {
	const { env, db, nameOrUrl } = opts;

	const set = await getStickerSet(env, nameOrUrl);

	// Pull the CURRENT stored metadata for any sticker already in THIS set's pack, so
	// the re-sync grid shows real NSFW/artist/emoji state (not defaults) and those rows
	// stay editable. Scoped to the set's own pack — cross-pack dedupe of NEW stickers is
	// still enforced server-side at import time.
	const pack = await packForSet(db, set.name);
	const meta = pack ? await packStickerMeta(db, pack.id) : new Map<string, ExistingStickerMeta>();

	const candidates: StickerCandidate[] = set.stickers.map((s, i) => {
		const existing = meta.get(s.fileUniqueId) ?? null;
		return { ...s, index: i, alreadyImported: !!existing, existing };
	});

	return { setName: set.name, title: set.title, candidates };
}

// Cap on decompressed .tgs output. Animated stickers are KB-scale; this stops a
// crafted high-ratio gzip (gzip reaches ~1000×) from expanding to hundreds of MB
// and OOMing the worker during import (self-inflicted DoS).
export const MAX_LOTTIE_BYTES = 5 * 1024 * 1024;

/**
 * Gunzip an ArrayBuffer using the Workers DecompressionStream API, aborting if
 * the decompressed size exceeds MAX_LOTTIE_BYTES. Returns the bytes.
 */
export async function gunzip(compressed: ArrayBuffer): Promise<Uint8Array> {
	const ds = new DecompressionStream('gzip');
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();

	// Don't await write() before close() — backpressure on small sticker payloads
	// is a non-issue and close() flushes. Swallow the write rejection (a malformed
	// gzip rejects on read below, which is where we want the error surfaced).
	void writer.write(new Uint8Array(compressed)).catch(() => {});
	void writer.close().catch(() => {});

	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > MAX_LOTTIE_BYTES) {
			await reader.cancel();
			throw new Error('animated sticker exceeds size limit');
		}
		chunks.push(value);
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/**
 * Parse + structurally validate gunzipped Lottie JSON, then re-serialize. This is
 * defense-in-depth on top of the expression-free lottie_light player (StickerMedia):
 *  - JSON.parse rejects non-JSON bytes (throws).
 *  - Require the Lottie shape (a version `v` + a `layers` array) so arbitrary JSON
 *    can't be stored and served as an "animated sticker".
 *  - Blank any embedded asset URL refs (assets[].u / .p) so the player can't be
 *    made to fetch off-origin content. Telegram .tgs are self-contained vectors.
 * Returns canonical JSON bytes to store as application/json.
 */
export function sanitizeLottie(jsonBytes: Uint8Array): Uint8Array {
	const data: unknown = JSON.parse(new TextDecoder().decode(jsonBytes));
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		throw new Error('not a Lottie animation');
	}
	const obj = data as Record<string, unknown>;
	if (!('v' in obj) || !Array.isArray(obj.layers)) {
		throw new Error('not a Lottie animation');
	}
	if (Array.isArray(obj.assets)) {
		for (const asset of obj.assets) {
			if (asset && typeof asset === 'object') {
				const a = asset as Record<string, unknown>;
				if ('u' in a) a.u = '';
				if ('p' in a) a.p = '';
			}
		}
	}
	return new TextEncoder().encode(JSON.stringify(obj));
}

/** Values for one sticker row (everything except packId/position, set by caller). */
type StickerRowValues = {
	artistId: number | null;
	imageUrl: string;
	width?: number | null;
	height?: number | null;
	format: 'png' | 'webp' | 'animated' | 'video';
	isAnimated?: boolean;
	nsfw: boolean;
	telegramFileUniqueId?: string | null;
};

/**
 * Insert one sticker row + its emoji rows. The single insert path for all 3 flows.
 * Returns false when the insert was skipped because its telegram_file_unique_id
 * already exists (the UNIQUE index catches a concurrent import that inserted the same
 * sticker after this flow snapshotted existingFileUniqueIds) — callers count that as
 * skipped, not imported, and no emoji rows are written for it.
 */
async function insertStickerWithEmojis(
	db: Database,
	values: StickerRowValues & { packId: number; position: number },
	emojis: string[]
): Promise<boolean> {
	const inserted = await db.insert(stickers).values(values).onConflictDoNothing().returning({ id: stickers.id });
	if (inserted.length === 0) return false; // concurrent duplicate — skip, don't add emoji rows
	const stickerId = inserted[0].id;
	// De-dupe emoji within a sticker (the junction has no PK; keep rows clean).
	for (const emoji of [...new Set(emojis)]) {
		await db.insert(stickerEmojis).values({ stickerId, emoji });
	}
	return true;
}

/** Update an existing sticker's editable metadata (nsfw + artist) and replace its
 * emoji rows. Used by the re-sync update path so an already-imported sticker's
 * NSFW/artist/emoji can be edited WITHOUT re-downloading or duplicating it. */
async function updateStickerMeta(
	db: Database,
	stickerId: number,
	values: { nsfw: boolean; artistId: number | null },
	emojis: string[]
): Promise<void> {
	await db.update(stickers).set({ nsfw: values.nsfw, artistId: values.artistId }).where(eq(stickers.id, stickerId));
	await db.delete(stickerEmojis).where(eq(stickerEmojis.stickerId, stickerId));
	for (const emoji of [...new Set(emojis)]) {
		await db.insert(stickerEmojis).values({ stickerId, emoji });
	}
}

/** Compare two emoji lists as order-insensitive sets (the junction has no order). */
function sameEmojis(a: string[], b: string[]): boolean {
	const sa = [...new Set(a)].sort();
	const sb = [...new Set(b)].sort();
	return sa.length === sb.length && sa.every((e, i) => e === sb[i]);
}

/** Smallest sticker id not yet used — for explicit, collision-free id allocation in a batch. */
async function nextStickerId(db: Database): Promise<number> {
	const row = await db.select({ m: sql<number>`COALESCE(MAX(${stickers.id}), 0)` }).from(stickers).get();
	return (row?.m ?? 0) + 1;
}

/** Smallest sticker-pack id not yet used — same explicit-id allocation as nextStickerId. */
async function nextPackId(db: Database): Promise<number> {
	const row = await db.select({ m: sql<number>`COALESCE(MAX(${stickerPacks.id}), 0)` }).from(stickerPacks).get();
	return (row?.m ?? 0) + 1;
}

/**
 * Build the batch statements for a list of sticker rows + their emoji rows.
 *
 * D1 has no interactive transactions — only db.batch() is atomic, and a batch must
 * be assembled up front, so we can't lean on INSERT … RETURNING to discover each
 * sticker's id mid-batch for its emoji rows. Instead we allocate sticker ids
 * explicitly starting at `startId` (which callers set past the current MAX, so the
 * ids never collide with existing rows or future autoincrement ids). Statements are
 * emitted as: sticker row, then that sticker's emoji rows, per sticker in order.
 *
 * This path does NOT use onConflictDoNothing: with the UNIQUE index on
 * telegram_file_unique_id, a sticker whose id collides with a concurrent insert now
 * fails the whole batch loudly (it rolls back atomically) rather than double-inserting.
 * Only the manual self-hosted create/edit paths use this, where such a race is not a
 * concern; that loud failure is acceptable.
 */
function stickerWriteStatements(
	db: Database,
	startId: number,
	rows: Array<StickerRowValues & { packId: number; position: number; emojis: string[] }>
): BatchItem<'sqlite'>[] {
	const statements: BatchItem<'sqlite'>[] = [];
	let id = startId;
	for (const { emojis, ...values } of rows) {
		statements.push(db.insert(stickers).values({ id, ...values }));
		// De-dupe emoji within a sticker (the junction has no PK; keep rows clean).
		for (const emoji of [...new Set(emojis)]) {
			statements.push(db.insert(stickerEmojis).values({ stickerId: id, emoji }));
		}
		id++;
	}
	return statements;
}

/**
 * Import a Telegram sticker set: downloads each eligible sticker, stores it,
 * inserts the pack + sticker + emoji rows.
 */
/**
 * The character a new pack belongs to. The site is for ONE character (the owner's
 * fursona), so this is implicit, never asked in the UI: prefer the configured
 * primaryCharacter by name, else the only/first character row. If none exists
 * yet, auto-creates one from the owner/persona name (characterId is a NOT NULL
 * fk) so first-run import "just works". Revisit if the site ever hosts multiple
 * characters.
 *
 * Only the auto-create path flags the row is_owner. A pre-existing character we
 * resolve here (the configured primaryCharacter, or the first row) is a real
 * curated character that legitimately belongs in public listings — flagging it
 * would hide a fork's actual fursona from the gallery — so it is left as-is. The
 * flag marks specifically the placeholder we manufacture solely for the stickers
 * FK, which is what pollutes public character surfaces on a fresh fork.
 */
export async function resolveSiteCharacterId(db: Database, settings: SiteSettings): Promise<number> {
	if (settings.primaryCharacter) {
		const c = await db
			.select({ id: characters.id })
			.from(characters)
			.where(eq(characters.name, settings.primaryCharacter))
			.get();
		if (c) return c.id;
	}
	const first = await db.select({ id: characters.id }).from(characters).orderBy(asc(characters.id)).get();
	if (first) return first.id;
	// The site is for ONE character (the owner's fursona) and none exists yet.
	// Auto-create it from the owner/persona name (falling back to the site name)
	// instead of failing, so first-run import just works. Flag it is_owner so it
	// stays out of public "featured characters" surfaces (it's the pack owner, not
	// a featured character) while remaining editable in admin.
	const name = (settings.ownerName || settings.siteName || 'Me').trim() || 'Me';
	const created = await db.insert(characters).values({ name, isOwner: true }).returning({ id: characters.id }).get();
	return created.id;
}

/**
 * Download ONE Telegram sticker and store its media (per the format rules), then
 * return the stored URL + resolved format. This is the per-sticker download/store
 * work factored out of importTelegramPack so the batched importer (importStickerBatch)
 * shares the exact same .tgs gunzip+sanitize, octet-stream media-type handling, and
 * storage-key layout. It does NOT touch the DB — the caller inserts the row so it
 * can decide the row's artist/nsfw/position.
 */
async function downloadAndStoreSticker(opts: {
	env: Env | undefined;
	storage: ReturnType<typeof getStorage>;
	packSlug: string;
	sticker: TelegramSticker;
	absolutize: (url: string) => string;
}): Promise<{ storedUrl: string; format: 'png' | 'webp' | 'animated' | 'video'; isAnimated: boolean }> {
	const { env, storage, packSlug, sticker, absolutize } = opts;
	const { bytes, filePath } = await downloadFile(env, sticker.fileId);
	const uuid = crypto.randomUUID();

	if (sticker.format === 'animated' || filePath.endsWith('.tgs')) {
		// Animated .tgs: gunzip (size-capped) → validate/strip Lottie → store JSON.
		const jsonBytes = sanitizeLottie(await gunzip(bytes));
		const { url } = await storage.put({
			suggestedKey: `stickers/${packSlug}/${uuid}.json`,
			body: jsonBytes,
			contentType: 'application/json',
			filename: `${uuid}.json`
		});
		return { storedUrl: absolutize(url), format: 'animated', isAnimated: true };
	}

	// Static raster or video. Telegram serves these as octet-stream, so derive the
	// real type from the file_path extension, not the response header.
	const ct = stickerMediaType(filePath);
	if (!isAllowedStickerType(ct)) throw new Error(`unsupported sticker type: ${filePath}`);
	const ext = extFromContentType(ct);
	const { url } = await storage.put({
		suggestedKey: `stickers/${packSlug}/${uuid}.${ext}`,
		body: bytes,
		contentType: ct,
		filename: `${uuid}.${ext}`
	});
	const format = formatFromContentType(ct, sticker.format);
	// Videos always animate; "static" rasters are sniffed for animated WebP/GIF
	// so the download endpoint never offers a flattening PNG conversion.
	const isAnimated = format === 'video' || isAnimatedRaster(new Uint8Array(bytes));
	return { storedUrl: absolutize(url), format, isAnimated };
}

export async function importTelegramPack(opts: {
	env: Env | undefined;
	settings: SiteSettings;
	db: Database;
	nameOrUrl: string;
	/** null = managed by the site owner; a value = single-artist pack. */
	managerArtistId: number | null;
	/** Fallback artist for stickers with no per-sticker override; null = unattributed. */
	defaultArtistId: number | null;
	/** Per-sticker admin overrides from the review form (index-keyed). */
	perSticker?: Record<number, PerStickerInput>;
	/** Make a provider's relative URL (R2 dev '/img/...') absolute for storage. */
	absolutize?: (url: string) => string;
}): Promise<ImportResult> {
	const {
		env,
		settings,
		db,
		nameOrUrl,
		managerArtistId,
		defaultArtistId,
		perSticker = {},
		absolutize = (u) => u
	} = opts;

	const set = await getStickerSet(env, nameOrUrl);
	const characterId = await resolveSiteCharacterId(db, settings);
	const storage = getStorage(env, settings);
	const result: ImportResult = { imported: 0, skipped: 0, failed: 0, items: [] };

	// Build per-sticker artist ids for the invariant resolver.
	const perStickerArtistIds = set.stickers.map((_, i) => perSticker[i]?.artistId ?? defaultArtistId ?? null);
	const resolvedArtistIds = resolveStickerArtistIds(managerArtistId, perStickerArtistIds);

	// Eligible = not excluded by the admin. Keep each sticker's original index so
	// perSticker overrides and resolvedArtistIds (both index-keyed) line up.
	const eligible = set.stickers
		.map((sticker, index) => ({ sticker, index }))
		.filter(({ index }) => !perSticker[index]?.excluded);

	// Stickers already in the DB (dedupe by Telegram's stable fileUniqueId, across
	// all packs) are reported as skipped, not re-imported. Select-all (not an IN-list)
	// to stay under D1's ~100 bound-param cap for large sets.
	const existingIds = await existingFileUniqueIds(db);

	const toImport = eligible.filter(({ sticker, index }) => {
		if (existingIds.has(sticker.fileUniqueId)) {
			result.skipped++;
			result.items.push({ fileUniqueId: sticker.fileUniqueId, index, status: 'skipped', emoji: sticker.emoji, fileId: sticker.fileId });
			return false;
		}
		return true;
	});

	// Nothing new to import (e.g. re-importing a set whose stickers all already
	// exist) — don't create an empty duplicate pack.
	if (toImport.length === 0) return result;

	// APPEND to the existing pack for this set if there is one (so re-importing to
	// retry a previously-failed sticker tops up the same pack instead of making a
	// duplicate). Otherwise create the pack (race-safe — a concurrent import of the
	// same set appends to the winner's pack rather than throwing). The pack slug
	// partitions this pack's objects in storage (stickers/{packSlug}/...); it's known
	// before the per-sticker put loop because the pack row exists (or is created) first.
	const telegramUrl = stickerSetUrl(set.name);
	const { packId, packSlug, created } = await getOrCreatePack(db, {
		telegramUrl,
		title: set.title,
		characterId,
		managerArtistId
	});

	// Continue positions after the current max when appending (an existing pack, or one
	// a concurrent import created — created=false covers both).
	let position = 0;
	if (!created) {
		const maxPos = (
			await db.select({ m: sql<number>`COALESCE(MAX(${stickers.position}), -1)` }).from(stickers).where(eq(stickers.packId, packId)).get()
		)?.m ?? -1;
		position = maxPos + 1;
	}

	for (const { sticker, index } of toImport) {
		try {
			const override = perSticker[index];
			const { storedUrl, format, isAnimated } = await downloadAndStoreSticker({ env, storage, packSlug, sticker, absolutize });

			const didInsert = await insertStickerWithEmojis(
				db,
				{
					packId,
					artistId: resolvedArtistIds[index],
					imageUrl: storedUrl,
					width: sticker.width,
					height: sticker.height,
					format,
					isAnimated,
					position,
					nsfw: override?.nsfw ?? false,
					telegramFileUniqueId: sticker.fileUniqueId
				},
				override?.emojis ?? (sticker.emoji ? [sticker.emoji] : [])
			);

			if (didInsert) {
				position++;
				result.imported++;
				result.items.push({ fileUniqueId: sticker.fileUniqueId, index, status: 'imported', emoji: sticker.emoji, fileId: sticker.fileId });
			} else {
				// A concurrent import inserted this sticker after our existingIds snapshot.
				result.skipped++;
				result.items.push({ fileUniqueId: sticker.fileUniqueId, index, status: 'skipped', emoji: sticker.emoji, fileId: sticker.fileId });
			}
		} catch (e) {
			result.failed++;
			result.items.push({
				fileUniqueId: sticker.fileUniqueId,
				index,
				status: 'failed',
				error: e instanceof Error ? e.message : String(e),
				emoji: sticker.emoji,
				fileId: sticker.fileId
			});
		}
	}

	// If every download/store failed AND we created the pack in this call, drop the
	// now-empty pack so we don't leave a 0-sticker pack with a dangling managerArtistId.
	// (An existing pack — or one a concurrent import created — is left untouched.)
	if (result.imported === 0 && created) {
		try {
			await db.delete(stickerPacks).where(eq(stickerPacks.id, packId));
		} catch {
			// Leave the empty pack rather than mask the per-sticker failures in result.
		}
	}

	return result;
}

/** One item in a client-driven import batch (the full sticker is resolved server-side by fileId). */
export interface StickerBatchItem {
	fileId: string;
	emojis: string[];
	/** null = unattributed (overridden by managerArtistId when the pack has one). */
	artistId: number | null;
	nsfw: boolean;
}

export interface StickerBatchResult {
	/** True when THIS batch created the pack row (so the client knows the pack now exists). */
	created: boolean;
	/** New stickers downloaded + inserted. */
	imported: number;
	/** Already-imported stickers whose metadata (nsfw/artist/emoji) was changed in place. */
	updated: number;
	/** Items left untouched: an unchanged already-imported sticker, or one already stored
	 * in another pack (cross-pack dedupe — not re-downloaded). */
	skipped: number;
	failed: { fileId: string; reason: string }[];
}

/**
 * Import ONE bounded batch of a Telegram set. The client splits a large pack into
 * batches and calls this repeatedly so each request stays well under Cloudflare's
 * ~100s edge timeout (the one-shot importTelegramPack downloads the whole set in a
 * single request and gets terminated mid-loop on 100+ sticker packs).
 *
 * It resolves the set once (one Telegram getStickerSet), creates-or-appends the pack
 * keyed by telegramUrl, then for each item:
 *  - already in THIS pack → re-sync its metadata in place if it changed (no download),
 *    else skip it as unchanged;
 *  - new → download + store + insert;
 *  - already stored in ANOTHER pack → skip (cross-pack dedupe; never re-downloaded).
 * So re-sending a batch is idempotent. A fully-failed batch that created the pack drops
 * it again, so an all-failed import leaves no empty pack.
 */
export async function importStickerBatch(opts: {
	env: Env | undefined;
	settings: SiteSettings;
	db: Database;
	nameOrUrl: string;
	/** null = managed by the site owner; a value = single-artist pack. */
	managerArtistId: number | null;
	items: StickerBatchItem[];
	/** Make a provider's relative URL (R2 dev '/img/...') absolute for storage. */
	absolutize?: (url: string) => string;
}): Promise<StickerBatchResult> {
	const { env, settings, db, nameOrUrl, managerArtistId, items, absolutize = (u) => u } = opts;

	const result: StickerBatchResult = { created: false, imported: 0, updated: 0, skipped: 0, failed: [] };
	if (items.length === 0) return result;

	const set = await getStickerSet(env, nameOrUrl);
	const characterId = await resolveSiteCharacterId(db, settings);
	const storage = getStorage(env, settings);

	// Resolve each batch item's fileId to the real sticker (carries fileUniqueId for
	// dedupe + width/height/format). An item whose fileId is no longer in the set
	// (stale client) is reported as failed rather than silently dropped.
	const byFileId = new Map(set.stickers.map((s) => [s.fileId, s]));

	// Enforce the single-artist invariant on this batch's per-item artist ids.
	const resolvedArtistIds = resolveStickerArtistIds(managerArtistId, items.map((it) => it.artistId));

	// Stickers already stored (dedupe by Telegram's stable fileUniqueId, across all
	// packs). Select-all (not an IN-list) to stay under D1's ~100 bound-param cap.
	const existingIds = await existingFileUniqueIds(db);

	// APPEND to the existing pack for this set if there is one (so each subsequent
	// batch tops up the same pack instead of making duplicates); otherwise create it.
	const telegramUrl = stickerSetUrl(set.name);
	const { packId, packSlug, created } = await getOrCreatePack(db, {
		telegramUrl,
		title: set.title,
		characterId,
		managerArtistId
	});
	result.created = created;

	let position = 0;
	// Metadata of stickers already in THIS pack, keyed by fileUniqueId — the update
	// targets for re-sync. Empty for a freshly-created pack. When a concurrent import
	// created the pack (created=false), this loads its already-inserted stickers, so
	// the loser skips/updates them exactly like appending to a pre-existing pack.
	let inPackMeta = new Map<string, ExistingStickerMeta>();
	if (!created) {
		const maxPos = (
			await db.select({ m: sql<number>`COALESCE(MAX(${stickers.position}), -1)` }).from(stickers).where(eq(stickers.packId, packId)).get()
		)?.m ?? -1;
		position = maxPos + 1;
		inPackMeta = await packStickerMeta(db, packId);
	}

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const sticker = byFileId.get(item.fileId);
		if (!sticker) {
			result.failed.push({ fileId: item.fileId, reason: 'sticker not found in set' });
			continue;
		}

		const desiredArtistId = resolvedArtistIds[i];
		// Emoji to persist: the admin's edit if any, else fall back to Telegram's emoji.
		const desiredEmojis = item.emojis.length ? item.emojis : sticker.emoji ? [sticker.emoji] : [];

		// Already in THIS pack → re-sync metadata in place (no download). Update only
		// when something actually changed so an unchanged batch is a no-op (skipped).
		const inPack = inPackMeta.get(sticker.fileUniqueId);
		if (inPack) {
			const changed =
				inPack.nsfw !== item.nsfw ||
				inPack.artistId !== desiredArtistId ||
				!sameEmojis(inPack.emojis, desiredEmojis);
			if (!changed) {
				result.skipped++;
				continue;
			}
			try {
				await updateStickerMeta(db, inPack.id, { nsfw: item.nsfw, artistId: desiredArtistId }, desiredEmojis);
				result.updated++;
			} catch (e) {
				result.failed.push({ fileId: item.fileId, reason: e instanceof Error ? e.message : String(e) });
			}
			continue;
		}

		// Already stored in another pack → don't duplicate, don't re-download.
		if (existingIds.has(sticker.fileUniqueId)) {
			result.skipped++;
			continue;
		}

		// New sticker → download + store + insert.
		try {
			const { storedUrl, format, isAnimated } = await downloadAndStoreSticker({ env, storage, packSlug, sticker, absolutize });
			const didInsert = await insertStickerWithEmojis(
				db,
				{
					packId,
					artistId: desiredArtistId,
					imageUrl: storedUrl,
					width: sticker.width,
					height: sticker.height,
					format,
					isAnimated,
					position,
					nsfw: item.nsfw,
					telegramFileUniqueId: sticker.fileUniqueId
				},
				desiredEmojis
			);
			// Guard against the same fileUniqueId appearing twice within one batch.
			existingIds.add(sticker.fileUniqueId);
			if (didInsert) {
				position++;
				result.imported++;
			} else {
				// A concurrent import inserted this sticker after our existingIds snapshot.
				result.skipped++;
			}
		} catch (e) {
			result.failed.push({ fileId: item.fileId, reason: e instanceof Error ? e.message : String(e) });
		}
	}

	// If this batch created the pack but stored nothing (every download/store failed),
	// drop the now-empty pack so an all-failed import leaves no 0-sticker orphan. A
	// pack we only appended to is left untouched.
	if (result.imported === 0 && result.created) {
		try {
			await db.delete(stickerPacks).where(eq(stickerPacks.id, packId));
			result.created = false;
		} catch {
			// Leave the empty pack rather than mask the per-sticker failures.
		}
	}

	return result;
}

/**
 * Cap on NEW stickers downloaded+stored in a SINGLE cron re-sync run, across ALL
 * packs. The re-sync runs inside one HTTP request and must finish under
 * Cloudflare's ~100s edge limit; each new sticker costs a getFile + CDN fetch +
 * storage put (worst case a couple of seconds). 25 keeps a worst-case run well
 * under the limit while still draining a backlog over a few scheduled invocations
 * (capReached signals the scheduler/next run that more remain). getStickerSet
 * calls for packs with nothing new are cheap no-ops and don't count against this.
 */
export const CRON_MAX_NEW = 25;

/** Per-pack line in a re-sync summary. */
export interface ResyncPackResult {
	slug: string;
	/** New stickers appended to this pack in this run. */
	imported: number;
}

export interface ResyncResult {
	/** Telegram packs we called getStickerSet on this run. */
	packsChecked: number;
	/** Total new stickers downloaded + inserted across all packs. */
	imported: number;
	/** True when the CRON_MAX_NEW budget was exhausted with new stickers still left
	 * to import — a subsequent run continues from where this one stopped. */
	capReached: boolean;
	perPack: ResyncPackResult[];
}

/**
 * Re-sync every Telegram-sourced pack: pull in stickers that have been ADDED to a
 * set on Telegram since it was imported, appending them to the existing pack. This
 * is the machine-to-machine counterpart of the admin import flow (no session, no
 * per-sticker review) driven by a scheduled cron.
 *
 * Per pack: one getStickerSet (cheap), diff against the GLOBAL set of stored
 * telegram_file_unique_ids (so a sticker already in any pack is never duplicated),
 * then download+store+insert the genuinely-new ones via the SAME
 * downloadAndStoreSticker / insertStickerWithEmojis machinery the import paths use
 * (Lottie gunzip+sanitize, octet-stream media typing, storage layout all shared).
 * New rows inherit the pack's manager artist (single-artist invariant), take their
 * emojis from Telegram, and are nsfw=false; they append after the pack's current
 * max position and inherit the pack's existing published visibility (we never flip
 * it). Idempotent: a run with nothing new writes nothing and returns a zero summary.
 *
 * Downloads are capped at CRON_MAX_NEW across the whole run to stay under the edge
 * timeout; when the budget is hit with work remaining, capReached=true and the loop
 * stops so a later run can continue. A pack whose getStickerSet fails (or an
 * individual sticker that fails to download) is logged and skipped — one bad pack
 * never aborts the rest of the run.
 */
export async function resyncTelegramPacks(opts: {
	env: Env | undefined;
	settings: SiteSettings;
	db: Database;
	/** Make a provider's relative URL (R2 dev '/img/...') absolute for storage. */
	absolutize?: (url: string) => string;
	/** Test seam — defaults to CRON_MAX_NEW. */
	maxNew?: number;
}): Promise<ResyncResult> {
	const { env, settings, db, absolutize = (u) => u, maxNew = CRON_MAX_NEW } = opts;

	const storage = getStorage(env, settings);
	const result: ResyncResult = { packsChecked: 0, imported: 0, capReached: false, perPack: [] };

	// All Telegram-sourced packs that carry a set URL to re-sync from.
	const packs = await db
		.select({ id: stickerPacks.id, slug: stickerPacks.slug, telegramUrl: stickerPacks.telegramUrl, managerArtistId: stickerPacks.managerArtistId })
		.from(stickerPacks)
		.where(and(eq(stickerPacks.source, 'telegram'), isNotNull(stickerPacks.telegramUrl)));

	// Global dedupe set — select-all (not an IN-list) to stay under D1's ~100
	// bound-param cap, same as the import paths. Updated in-loop so a sticker can't
	// be imported twice within one run.
	const existingIds = await existingFileUniqueIds(db);

	let budget = maxNew;

	for (const pack of packs) {
		if (result.capReached) break;
		if (!pack.telegramUrl) continue;
		result.packsChecked++;

		let importedForPack = 0;
		try {
			const set = await getStickerSet(env, pack.telegramUrl);
			const newStickers = set.stickers.filter((s) => s.fileUniqueId && !existingIds.has(s.fileUniqueId));

			if (newStickers.length > 0) {
				const maxPos =
					(await db.select({ m: sql<number>`COALESCE(MAX(${stickers.position}), -1)` }).from(stickers).where(eq(stickers.packId, pack.id)).get())?.m ?? -1;
				let position = maxPos + 1;

				// Managed pack → its manager. Unmanaged pack → its single attributed
				// artist when the existing stickers are effectively single-artist
				// (#184); otherwise unattributed, as before. One grouped query per
				// pack, and only when there is something to append.
				let appendArtistId: number | null = pack.managerArtistId;
				if (appendArtistId == null) {
					// STRICT inference: nulls are included in the distinct set on purpose,
					// so any unattributed existing sticker blocks inference — see
					// inferAppendedArtistId for the rationale (PR #195 review).
					const distinct = await db
						.select({ artistId: stickers.artistId })
						.from(stickers)
						.where(eq(stickers.packId, pack.id))
						.groupBy(stickers.artistId);
					appendArtistId = inferAppendedArtistId(distinct.map((d) => d.artistId));
				}

				for (const sticker of newStickers) {
					if (budget <= 0) {
						result.capReached = true;
						break;
					}
					try {
						const { storedUrl, format, isAnimated } = await downloadAndStoreSticker({ env, storage, packSlug: pack.slug, sticker, absolutize });
						const didInsert = await insertStickerWithEmojis(
							db,
							{
								packId: pack.id,
								artistId: appendArtistId,
								imageUrl: storedUrl,
								width: sticker.width,
								height: sticker.height,
								format,
								isAnimated,
								position,
								nsfw: false,
								telegramFileUniqueId: sticker.fileUniqueId
							},
							sticker.emoji ? [sticker.emoji] : []
						);
						existingIds.add(sticker.fileUniqueId);
						// A concurrent insert of the same sticker (unlikely for a solo cron)
						// no-ops on the UNIQUE index — don't count it or spend budget on it.
						if (didInsert) {
							position++;
							budget--;
							importedForPack++;
							result.imported++;
						}
					} catch (e) {
						// One sticker failing (bad download/store) shouldn't abort the run.
						console.error(`[resync] ${pack.slug}: sticker ${sticker.fileUniqueId} failed:`, e instanceof Error ? e.message : e);
					}
				}
			}
		} catch (e) {
			// A pack whose set can't be fetched is logged and skipped, not fatal.
			console.error(`[resync] ${pack.slug}: getStickerSet failed:`, e instanceof Error ? e.message : e);
		}

		result.perPack.push({ slug: pack.slug, imported: importedForPack });
	}

	return result;
}

/** Map a stored content-type to a non-animated sticker format. */
function formatFromContentType(
	contentType: string,
	hint: 'png' | 'webp' | 'animated' | 'video'
): 'png' | 'webp' | 'video' {
	const base = contentType.split(';')[0].trim().toLowerCase();
	if (base === 'video/webm' || hint === 'video') return 'video';
	if (base === 'image/png') return 'png';
	if (base === 'image/gif') return 'png'; // schema enum has no 'gif'; <img> renders it fine
	return 'webp';
}

export interface ManualStickerInput {
	imageUrl: string;
	artistId: number | null;
	emojis: string[];
	nsfw: boolean;
	position: number;
	width?: number | null;
	height?: number | null;
	format: 'png' | 'webp' | 'animated' | 'video';
}

export interface ManualPackInput {
	name: string;
	slug?: string;
	description?: string | null;
	coverImageUrl?: string | null;
	// No characterId: the pack's character is implicit (the site's one character),
	// resolved server-side on create and left unchanged on edit.
	managerArtistId: number | null;
	telegramUrl?: string | null;
	published?: boolean;
	stickerInputs: ManualStickerInput[];
}

const STICKER_FORMATS = ['png', 'webp', 'animated', 'video'] as const;

/**
 * Parse the repeated `sticker[i][...]` fields from a manual/edit pack form into
 * ordered ManualStickerInputs. Shared by the manual-create and edit actions so the
 * (fiddly) FormData parsing lives in exactly one place. Rows with no imageUrl are
 * skipped; position is the compacted order.
 */
export function parseStickerFormInputs(data: FormData, defaultArtistId: number | null): ManualStickerInput[] {
	const indices = new Set<number>();
	for (const key of data.keys()) {
		const m = /^sticker\[(\d+)\]/.exec(key);
		if (m) indices.add(Number(m[1]));
	}

	const inputs: ManualStickerInput[] = [];
	for (const i of [...indices].sort((a, b) => a - b)) {
		const imageUrl = sanitizeUrl(data.get(`sticker[${i}][imageUrl]`) as string);
		if (!imageUrl) continue;
		const artistIdRaw = data.get(`sticker[${i}][artistId]`) as string;
		const emojisRaw = data.get(`sticker[${i}][emojis]`) as string;
		const formatRaw = (data.get(`sticker[${i}][format]`) as string) || 'webp';
		inputs.push({
			imageUrl,
			artistId: artistIdRaw ? Number(artistIdRaw) : defaultArtistId ?? null,
			emojis: emojisRaw ? emojisRaw.split(',').map((e) => e.trim()).filter(Boolean) : [],
			// The checkbox ships a hidden `0` fallback BEFORE the `1`, so a checked box
			// posts both values. .get() returns the first ('0') and would drop every
			// NSFW flag — read all values and look for the '1'.
			nsfw: data.getAll(`sticker[${i}][nsfw]`).includes('1'),
			position: inputs.length,
			format: (STICKER_FORMATS as readonly string[]).includes(formatRaw)
				? (formatRaw as ManualStickerInput['format'])
				: 'webp'
		});
	}
	return inputs;
}

// Sniff cap: a manual pack can hold 100+ stickers; fetching every raster at
// once would blow the Workers subrequest/connection budget.
const SNIFF_CONCURRENCY = 4;

/**
 * Animation flag for ONE manual-save input: rasters are sniffed by URL (null =
 * undetermined — callers pick the default), video/Lottie are always animated.
 * Callers fan this out via mapWithConcurrency (at most SNIFF_CONCURRENCY
 * fetches at a time) and short-circuit rows they don't want fetched there.
 * fetchFn is deliberately the EVENT fetch (unlike the download transform path):
 * it resolves root-relative /img/<key> stored URLs through the app router, and
 * these are admin-only save flows, so the cookie-carrying fetch is fine here.
 */
function sniffManualInput(
	s: ManualStickerInput,
	fetchFn: typeof fetch,
	origin?: string
): Promise<boolean | null> {
	return isRasterFormat(s.format)
		? sniffAnimatedFromUrl(s.imageUrl, fetchFn, origin)
		: Promise.resolve(true);
}

/**
 * Reject any sticker/cover URL we don't host ourselves. The manual form only ever
 * submits URLs returned by /api/upload (our storage), so a URL we don't own means
 * a hand-crafted request trying to point a sticker at off-origin content — refuse
 * it so stored media is always self-hosted (defeats the off-origin Lottie vector).
 *
 * `knownUrls` — URLs already stored for the pack being edited — are exempt: they
 * were validated when first stored, and re-checking them against the CURRENT
 * storage config (public domain / providers, which may have changed since) would
 * make any edit of an older pack fail even when no image changed. Only URLs new
 * to the pack must pass the self-hosted check.
 */
function assertSelfHosted(
	env: Env | undefined,
	settings: SiteSettings,
	input: ManualPackInput,
	knownUrls?: ReadonlySet<string>
): void {
	const urls = [
		...(input.coverImageUrl ? [input.coverImageUrl] : []),
		...input.stickerInputs.map((s) => s.imageUrl)
	];
	for (const url of urls) {
		if (knownUrls?.has(url)) continue;
		if (!isOwnedUrl(env, settings, url)) {
			throw new Error('Sticker and cover images must be uploaded here, not external URLs.');
		}
	}
}

/**
 * Create a self-hosted pack from already-uploaded sticker URLs. The client uploads
 * files to /api/upload first (which stores them via the active provider); this
 * records the rows. Throws if any URL isn't one we host.
 */
export async function saveManualPack(opts: {
	env: Env | undefined;
	settings: SiteSettings;
	db: Database;
	input: ManualPackInput;
	/** Request origin so root-relative stored URLs (/img/<key>) can be sniffed. */
	origin?: string;
	/** Fetch used for the animation sniff (event fetch / test seam). */
	fetchFn?: typeof fetch;
}): Promise<{ packId: number; slug: string }> {
	const { env, settings, db, input, origin, fetchFn = fetch } = opts;
	assertSelfHosted(env, settings, input);

	const characterId = await resolveSiteCharacterId(db, settings);
	// Derive a collision-free slug (deterministic -2/-3 suffix) so a name that slugifies
	// to an existing pack's slug doesn't fail the atomic batch on the UNIQUE constraint.
	const slug = input.slug ?? (await uniqueSlug(db, slugify(input.name)));

	// Enforce the single-artist invariant on the per-sticker artist ids.
	const resolvedArtistIds = resolveStickerArtistIds(input.managerArtistId, input.stickerInputs.map((s) => s.artistId));

	// Allocate explicit ids so the pack, sticker, and emoji rows all go in ONE atomic
	// db.batch (D1 has no interactive transactions; see stickerWriteStatements). A
	// mid-write failure then leaves nothing rather than an empty/partial pack.
	const packId = await nextPackId(db);
	const startId = await nextStickerId(db);

	// Best-effort animation sniff for the freshly uploaded rasters (see
	// sniffAnimatedFromUrl); an undetermined sniff (null) defaults to static,
	// which the backfill endpoint can correct later.
	const sniffed = await mapWithConcurrency(input.stickerInputs, SNIFF_CONCURRENCY, (s) =>
		sniffManualInput(s, fetchFn, origin)
	);

	const rows = input.stickerInputs.map((s, i) => ({
		packId,
		artistId: resolvedArtistIds[i],
		imageUrl: s.imageUrl,
		width: s.width ?? null,
		height: s.height ?? null,
		format: s.format,
		isAnimated: sniffed[i] ?? false,
		position: s.position,
		nsfw: s.nsfw,
		emojis: s.emojis
	}));

	const statements: BatchItem<'sqlite'>[] = [
		db.insert(stickerPacks).values({
			id: packId,
			name: input.name,
			slug,
			description: input.description ?? null,
			coverImageUrl: input.coverImageUrl ?? null,
			characterId,
			managerArtistId: input.managerArtistId,
			telegramUrl: input.telegramUrl ?? null,
			source: 'self-hosted',
			published: input.published ?? false
		}),
		...stickerWriteStatements(db, startId, rows)
	];
	await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
	// Same-isolate immediacy for the nav/tab probe; other isolates converge by TTL.
	clearStickerTabCache();

	return { packId, slug };
}

/**
 * Update an existing self-hosted pack: update pack fields, replace all sticker
 * rows (cascade removes their emoji), then best-effort delete the storage objects
 * for any sticker/cover that's no longer referenced (so edits don't orphan files).
 */
export async function updateManualPack(opts: {
	env: Env | undefined;
	settings: SiteSettings;
	db: Database;
	packId: number;
	input: ManualPackInput;
	/** Request origin so root-relative stored URLs (/img/<key>) can be sniffed. */
	origin?: string;
	/** Fetch used for the animation sniff (event fetch / test seam). */
	fetchFn?: typeof fetch;
}): Promise<void> {
	const { env, settings, db, packId, input, origin, fetchFn = fetch } = opts;

	// Snapshot existing stickers before we mutate. We need imageUrl for storage
	// cleanup AND width/height/telegramFileUniqueId so the edit PRESERVES the columns
	// the form doesn't carry (it only submits imageUrl/format/emojis/artist/nsfw).
	// Keyed by imageUrl — the stable identity of a stored sticker across an edit.
	// Without this, editing any pack would null width/height, and editing a
	// Telegram-sourced pack would null telegram_file_unique_id and so break the
	// re-import dedupe that keys off it (duplicating every sticker on a top-up).
	const oldStickers = await db
		.select({
			imageUrl: stickers.imageUrl,
			width: stickers.width,
			height: stickers.height,
			isAnimated: stickers.isAnimated,
			telegramFileUniqueId: stickers.telegramFileUniqueId
		})
		.from(stickers)
		.where(eq(stickers.packId, packId));
	const preserved = new Map(oldStickers.map((s) => [s.imageUrl, s]));

	const oldPack = await db
		.select({ coverImageUrl: stickerPacks.coverImageUrl })
		.from(stickerPacks)
		.where(eq(stickerPacks.id, packId))
		.get();

	// URLs already stored for this pack were validated when first stored — exempt
	// them so an edit that touches no images can't fail if the storage config has
	// changed since. Anything else must be self-hosted (see assertSelfHosted).
	const knownUrls = new Set(oldStickers.map((s) => s.imageUrl));
	if (oldPack?.coverImageUrl) knownUrls.add(oldPack.coverImageUrl);
	assertSelfHosted(env, settings, input, knownUrls);

	const resolvedArtistIds = resolveStickerArtistIds(input.managerArtistId, input.stickerInputs.map((s) => s.artistId));

	// Animation flags: a row kept across the edit (same imageUrl) carries its prior
	// flag — short-circuited here so it is never fetched; a NEW raster upload gets
	// a best-effort sniff. Kept rows were already sniffed (or backfilled), so this
	// only fetches the handful of new files.
	const sniffed = await mapWithConcurrency(input.stickerInputs, SNIFF_CONCURRENCY, async (s) =>
		preserved.has(s.imageUrl) ? null : sniffManualInput(s, fetchFn, origin)
	);

	const rows = input.stickerInputs.map((s, i) => {
		const prior = preserved.get(s.imageUrl);
		return {
			packId,
			artistId: resolvedArtistIds[i],
			imageUrl: s.imageUrl,
			// Carry the prior row's dimensions / Telegram id forward — the form never
			// submits them, so re-inserting without this would null these columns.
			width: s.width ?? prior?.width ?? null,
			height: s.height ?? prior?.height ?? null,
			format: s.format,
			isAnimated: prior?.isAnimated ?? sniffed[i] ?? false,
			position: s.position,
			nsfw: s.nsfw,
			telegramFileUniqueId: prior?.telegramFileUniqueId ?? null,
			emojis: s.emojis
		};
	});

	// Replace the pack atomically. D1 has no interactive transactions, so the pack
	// update + wholesale sticker delete + re-insert (explicit ids; see
	// stickerWriteStatements) go through a single db.batch — all-or-nothing, so a
	// mid-write failure can't leave the old rows gone and only some new ones in place.
	// (DELETE on an empty set is a no-op; FK cascade removes the sticker_emojis rows.)
	const startId = await nextStickerId(db);
	const statements: BatchItem<'sqlite'>[] = [
		db
			.update(stickerPacks)
			.set({
				// characterId intentionally not updated — a pack's character is implicit
				// and fixed (the site's one character).
				name: input.name,
				description: input.description ?? null,
				coverImageUrl: input.coverImageUrl ?? null,
				managerArtistId: input.managerArtistId,
				telegramUrl: input.telegramUrl ?? null,
				published: input.published ?? false
			})
			.where(eq(stickerPacks.id, packId)),
		db.delete(stickers).where(eq(stickers.packId, packId)),
		...stickerWriteStatements(db, startId, rows)
	];
	await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
	// Same-isolate immediacy for the nav/tab probe (the edit form can flip
	// `published`); other isolates converge by TTL.
	clearStickerTabCache();

	// Best-effort storage cleanup: delete objects no longer referenced by the pack.
	const keep = new Set([
		...input.stickerInputs.map((s) => s.imageUrl),
		...(input.coverImageUrl ? [input.coverImageUrl] : [])
	]);
	const removed = [
		...oldStickers.map((r) => r.imageUrl),
		...(oldPack?.coverImageUrl ? [oldPack.coverImageUrl] : [])
	].filter((url) => !keep.has(url));
	for (const url of removed) {
		try {
			await deleteFile(env, settings, url);
		} catch {
			// Don't fail the edit on cleanup error — orphan sweep handles leftovers.
		}
	}
}

/**
 * Delete a pack (cascade removes stickers + emoji rows via FK), then
 * best-effort clean up each sticker's stored file and the cover image.
 */
export async function deletePack(opts: {
	env: Env | undefined;
	settings: SiteSettings;
	db: Database;
	packId: number;
}): Promise<void> {
	const { env, settings, db, packId } = opts;

	// Collect URLs to clean up before deleting (FK cascade will remove stickers).
	const stickerRows = await db
		.select({ imageUrl: stickers.imageUrl })
		.from(stickers)
		.where(eq(stickers.packId, packId));
	const packRow = await db
		.select({ coverImageUrl: stickerPacks.coverImageUrl })
		.from(stickerPacks)
		.where(eq(stickerPacks.id, packId))
		.get();

	// Delete the pack row — sticker + stickerEmojis cascade via FK.
	await db.delete(stickerPacks).where(eq(stickerPacks.id, packId));
	// Same-isolate immediacy for the nav/tab probe; other isolates converge by TTL.
	clearStickerTabCache();

	// Best-effort storage cleanup — don't fail if individual deletes error.
	const urlsToDelete = [
		...stickerRows.map((r) => r.imageUrl),
		...(packRow?.coverImageUrl ? [packRow.coverImageUrl] : [])
	];
	for (const url of urlsToDelete) {
		try {
			await deleteFile(env, settings, url);
		} catch {
			// Orphaned objects can be cleaned by the existing storage orphan cleanup.
		}
	}
}

/**
 * Resolve or create an artist from form data, mirroring the image-edit flow.
 * Returns the artist id.
 */
export async function resolveOrCreateArtist(
	db: Database,
	opts: {
		artistId: string | null;
		artistName: string;
		twitterUrl: string | null;
		blueskyUrl: string | null;
		telegramUrl: string | null;
		furAffinityUrl: string | null;
		deviantArtUrl: string | null;
		patreonUrl: string | null;
		instagramUrl: string | null;
		/** When this artist was pulled from the shared registry: its global id +
		 * version + pre-resolved avatar, so the new local row is linked. */
		globalId?: string | null;
		registryVersion?: number | null;
		avatarUrl?: string | null;
		/** Storage context so a freshly-resolved avatar is re-hosted to our own CDN
		 * (can't rot to a 404) instead of stored as a hotlink. */
		rehost?: AvatarRehostContext;
	}
): Promise<number | null> {
	const {
		artistId,
		artistName,
		globalId,
		registryVersion,
		avatarUrl: providedAvatar,
		rehost,
		...socials
	} = opts;
	if (artistId && artistId !== 'new') return Number(artistId);
	if (!artistName) return null;

	// Use the registry-provided avatar when present; else resolve from social
	// links (best-effort — ignore errors).
	let avatarUrl: string | null = providedAvatar ?? null;
	let resolvedNow = false;
	if (!avatarUrl) {
		try {
			const { resolveAvatarUrl } = await import('$lib/server/avatar');
			avatarUrl = await resolveAvatarUrl(
				{
					blueskyUrl: socials.blueskyUrl,
					twitterUrl: socials.twitterUrl,
					furAffinityUrl: socials.furAffinityUrl,
					patreonUrl: socials.patreonUrl
				},
				rehost
			);
			resolvedNow = !!avatarUrl;
		} catch {
			// avatar resolution is non-critical
		}
	}

	const [newArtist] = await db
		.insert(artists)
		.values({
			name: artistName,
			avatarUrl,
			// Stamp when we resolved an avatar here (re-hosted when a rehost context
			// was given and the store succeeded; a source hotlink otherwise) so the
			// refresh cron doesn't immediately re-do a just-created row. A
			// registry-provided avatar isn't stamped — it's re-refreshed by the
			// registry sync, not this loop.
			avatarResolvedAt: resolvedNow ? new Date().toISOString() : null,
			...socials,
			globalId: globalId ?? null,
			registryVersion: registryVersion ?? null,
			registrySyncedAt: globalId ? new Date().toISOString() : null
		})
		.returning({ id: artists.id });
	return newArtist.id;
}
