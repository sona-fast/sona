import { sqliteTable, text, integer, index, uniqueIndex, primaryKey, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const artists = sqliteTable('artists', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	avatarUrl: text('avatar_url'),
	twitterUrl: text('twitter_url'),
	blueskyUrl: text('bluesky_url'),
	telegramUrl: text('telegram_url'),
	furAffinityUrl: text('furaffinity_url'),
	deviantArtUrl: text('deviantart_url'),
	patreonUrl: text('patreon_url'),
	instagramUrl: text('instagram_url'),
	// Link to the shared artist registry (sona-registry). NULL = local-only, not
	// yet in the registry. The local autoincrement `id` stays the render-time
	// identity + FK target; global_id is only the cross-instance bridge. Unique so
	// two local rows can't link to the same registry artist (SQLite allows many
	// NULLs under a unique index, so local-only artists are unaffected).
	globalId: text('global_id').unique(),
	registryVersion: integer('registry_version'),
	registrySyncedAt: text('registry_synced_at'),
	// Former identities ("also known as"), JSON array of {displayName, socials}.
	// NULL = none. Sourced from the registry (an artist who renamed keeps their old
	// handles here) so old ?artist=<OldName> links still resolve. See artist-sync.ts.
	aliases: text('aliases'),
	// Last time we successfully resolved + re-hosted this artist's avatar. NULL =
	// never (rows predating avatar re-hosting, or a resolve that never succeeded).
	// The refresh cron rotates oldest-first (NULLs first) so re-hosted copies stay
	// current as artists change their pictures. See avatar.ts / api/cron/refresh-avatars.
	avatarResolvedAt: text('avatar_resolved_at'),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
});

export const collections = sqliteTable('collections', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	slug: text('slug').notNull().unique(),
	coverImageUrl: text('cover_image_url'),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
});

export const tags = sqliteTable('tags', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
});

export const images = sqliteTable('images', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	title: text('title').notNull(),
	slug: text('slug').notNull().unique(),
	imageUrl: text('image_url').notNull(),
	thumbnailUrl: text('thumbnail_url'),
	width: integer('width'),
	height: integer('height'),
	fileSize: integer('file_size'),
	md5hash: text('md5hash'),
	nsfw: integer('nsfw', { mode: 'boolean' }).notNull().default(false),
	published: integer('published', { mode: 'boolean' }).notNull().default(true),
	sourcePostUrl: text('source_post_url'),
	artistId: integer('artist_id').notNull().references(() => artists.id),
	collectionId: integer('collection_id').references(() => collections.id),
	commissionedAt: text('commissioned_at'),
	// Variant grouping: a row is a parent when null, a variant when set. One level
	// only (enforced in form actions, not schema). Deleting a parent cascades.
	parentImageId: integer('parent_image_id').references((): AnySQLiteColumn => images.id, {
		onDelete: 'cascade'
	}),
	variantLabel: text('variant_label'),
	// Operator-curated "Featured" section on /art (#58). `featured` marks an image
	// for the section; `featuredOrder` (nullable) sets its position — ordered
	// ASC NULLS LAST, then createdAt DESC, so the first is the hero and the next
	// few are the supporting row.
	featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
	featuredOrder: integer('featured_order'),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
}, (table) => [
	// Public gallery filters and admin views join/filter on artist_id constantly;
	// without this every lookup scans the whole images table.
	index('images_artist_id_idx').on(table.artistId)
]);

export const siteSettings = sqliteTable('site_settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

export const sessions = sqliteTable('sessions', {
	token: text('token').primaryKey(),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
	expiresAt: text('expires_at').notNull()
});

export const characters = sqliteTable('characters', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	ownerName: text('owner_name'),
	url: text('url'),
	twitterUrl: text('twitter_url'),
	blueskyUrl: text('bluesky_url'),
	telegramUrl: text('telegram_url'),
	furAffinityUrl: text('furaffinity_url'),
	deviantArtUrl: text('deviantart_url'),
	patreonUrl: text('patreon_url'),
	instagramUrl: text('instagram_url'),
	avatarUrl: text('avatar_url'),
	// The site's implicit "owner" character, auto-created only to satisfy the
	// stickers character FK on a fork that had no characters yet (see
	// resolveSiteCharacterId). Excluded from public character listings — it's the
	// pack owner, not part of the featured cast — but still editable in admin.
	isOwner: integer('is_owner', { mode: 'boolean' }).notNull().default(false),
	// The character's canonical reference image ("ref sheet"), chosen explicitly by
	// an operator from the gallery and shown on /art. NULL = none set; /art then
	// falls back to the most recent published image tagged 'reference'. Kept
	// nullable so clearing it is a no-op; deleting the image just nulls this out
	// (SET NULL) rather than blocking the delete.
	referenceImageId: integer('reference_image_id').references(() => images.id, { onDelete: 'set null' }),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
});

export const imageCharacters = sqliteTable('image_characters', {
	imageId: integer('image_id').notNull().references(() => images.id, { onDelete: 'cascade' }),
	characterId: integer('character_id').notNull().references(() => characters.id, { onDelete: 'cascade' })
});

export const imageTags = sqliteTable('image_tags', {
	imageId: integer('image_id').notNull().references(() => images.id, { onDelete: 'cascade' }),
	tagId: integer('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' })
});

// Fursuit photos imported from FurTrack and self-hosted (image_url points to our
// storage, e.g. R2). One row per FurTrack post; furtrack_post_id dedupes imports.
export const fursuitPhotos = sqliteTable('fursuit_photos', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	furtrackPostId: integer('furtrack_post_id').notNull().unique(),
	character: text('character').notNull(),
	description: text('description'),
	imageUrl: text('image_url').notNull(),
	width: integer('width'),
	height: integer('height'),
	photographer: text('photographer').notNull(),
	photographerUrl: text('photographer_url'),
	event: text('event'),
	license: text('license').notNull(),
	// Manual permission override for non-displayable licenses. NULL = no override,
	// gating is by `license.displayable` only. Non-NULL = the admin recorded direct
	// permission from the photographer (e.g. "Telegram DM 2026-05-29"); the photo
	// renders publicly despite its license. createdAt is the granted-at date.
	permissionSource: text('permission_source'),
	furtrackUrl: text('furtrack_url').notNull(),
	takenAt: text('taken_at'),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
});

// A sticker pack — either mirrored from a Telegram set (`source: 'telegram'`,
// with `telegramUrl`) or self-run from uploaded files (`source: 'self-hosted'`).
// A pack is *of* one character. `managerArtistId` encodes pack shape: a value =
// single-artist pack managed by that artist (every sticker's artistId equals it —
// enforced in $lib/server/stickers); null = self-managed by the site owner
// (the site owner), which may mix many artists. There is deliberately no stored
// "single vs multi" flag — shape is derived.
export const stickerPacks = sqliteTable('sticker_packs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	slug: text('slug').notNull().unique(),
	description: text('description'),
	// Contact-sheet / preview only — a cover, never the source for emoji search.
	coverImageUrl: text('cover_image_url'),
	characterId: integer('character_id').notNull().references(() => characters.id),
	// null = managed by the site owner; a value = managed by that artist (and
	// the pack is therefore single-artist).
	managerArtistId: integer('manager_artist_id').references(() => artists.id),
	telegramUrl: text('telegram_url'),
	source: text('source', { enum: ['telegram', 'self-hosted'] }).notNull(),
	published: integer('published', { mode: 'boolean' }).notNull().default(true),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
});

// One sticker. Attribution is PER-STICKER (`artistId`) so a self-managed pack can
// mix artists. `format` anticipates Telegram's animated `.tgs` and video `.webm`
// alongside static raster. `telegramFileUniqueId` (Telegram's stable, bot-agnostic
// id) dedupes re-imports of the same set.
export const stickers = sqliteTable('stickers', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	packId: integer('pack_id').notNull().references(() => stickerPacks.id, { onDelete: 'cascade' }),
	// Nullable: a sticker can be imported unattributed ("Unassigned") and credited
	// to an artist later. Public credit shows "Unattributed" until then.
	artistId: integer('artist_id').references(() => artists.id),
	imageUrl: text('image_url').notNull(),
	thumbnailUrl: text('thumbnail_url'),
	width: integer('width'),
	height: integer('height'),
	format: text('format', { enum: ['png', 'webp', 'animated', 'video'] }).notNull().default('webp'),
	// True when the stored file actually animates. Always true for 'animated'
	// (Lottie) and 'video'; for static-raster rows it marks animated WebP/GIF
	// (sniffed from the bytes at import — see isAnimatedRaster) so the download
	// endpoint never offers a PNG conversion that would flatten the animation.
	// Backfilled for pre-existing rows by POST /api/stickers/backfill-animated.
	isAnimated: integer('is_animated', { mode: 'boolean' }).notNull().default(false),
	position: integer('position').notNull().default(0),
	nsfw: integer('nsfw', { mode: 'boolean' }).notNull().default(false),
	telegramFileUniqueId: text('telegram_file_unique_id'),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
}, (table) => [
	// Telegram's fileUniqueId dedupes re-imports of the same set. UNIQUE so two
	// concurrent imports can't double-insert the same sticker (both snapshot the
	// existing-ids set before either writes, so the app-level check races). The
	// column is nullable and SQLite allows many NULLs under a unique index, so
	// self-hosted stickers (no Telegram id) are unaffected.
	uniqueIndex('stickers_telegram_file_unique_id_unique').on(table.telegramFileUniqueId)
]);

// Many emoji per sticker; search-by-emoji filters on this junction. No PK, mirroring
// image_tags/image_characters; (stickerId, emoji) uniqueness is kept in app code.
export const stickerEmojis = sqliteTable('sticker_emojis', {
	stickerId: integer('sticker_id').notNull().references(() => stickers.id, { onDelete: 'cascade' }),
	emoji: text('emoji').notNull()
});

// --- Observability (issue #6, Phase 1: Tier-B operational telemetry) ---
// Everything here is measured IN-APP and written to this fork's OWN database,
// so it is tenant-isolated by construction — one fork can never read another's
// numbers (see src/lib/server/observability.ts for the isolation note). Rolled-up
// counters, never a row per request: cheap, contention-safe writes.

// One row per (day, metric, dim). Incremented with a bounded UPSERT
// (ON CONFLICT DO UPDATE count = count + n), so write cost is O(1) and the table
// stays small regardless of traffic. `dim` is a low-cardinality label (route
// class, status bucket, ok/fail) — never a raw path, id, IP or UA.
export const metricRollup = sqliteTable('metric_rollup', {
	day: text('day').notNull(), // 'YYYY-MM-DD' (UTC)
	metric: text('metric').notNull(), // operational: 'request'|'error'|'upload'|'email'|'download'; Tier-A visitors: 'pageview'|'referrer'|'country'|'device'
	dim: text('dim').notNull().default(''), // '' when N/A; Tier-A: page path, referrer host, country code, or device class
	count: integer('count').notNull().default(0)
}, (table) => [primaryKey({ columns: [table.day, table.metric, table.dim] })]);

// Tier-B error detail — a capped ring. Holds route + status + a PII-free message
// only; NO IP, UA, headers, body or stack. Pruned to a bounded row count so it
// can't grow without limit (see recordError in observability.ts).
export const errorSample = sqliteTable('error_sample', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	ts: text('ts').notNull(), // ISO timestamp
	route: text('route').notNull(),
	status: integer('status').notNull(),
	message: text('message').notNull()
});

// Background-job heartbeat — one row per named cron, overwritten each run. Lets
// the dashboard show "last ran / ok|failed" without a per-run log table.
export const jobRun = sqliteTable('job_run', {
	name: text('name').primaryKey(), // 'cleanup-orphans' | 'resync-telegram' | 'sync-artists'
	status: text('status').notNull(), // 'ok' | 'failed'
	ranAt: text('ran_at').notNull(), // ISO timestamp of the last run
	detail: text('detail') // short, PII-free summary (e.g. 'refreshed 3, linked 1')
});

// Convention appearances, shown publicly on /about ("Upcoming conventions").
// Rows are picked from the cons.fyi feed in admin or entered manually.
export const conventions = sqliteTable('conventions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	location: text('location'),
	startDate: text('start_date').notNull(),
	endDate: text('end_date'),
	url: text('url'),
	// 'confirmed' | 'maybe' | 'considering' — planning state shown as a badge in admin.
	status: text('status').notNull().default('confirmed'),
	// cons.fyi event id when picked from the feed (null for manual entries); used to dedupe.
	sourceId: text('source_id'),
	// IANA zone of the event itself (e.g. 'America/Denver'), from the cons.fyi feed.
	// Decides whether the convention is happening *now*: start/end are bare calendar
	// dates, so "is it running" has to be asked in the event's own zone, not the
	// server's and not the reader's. NULL for manual entries and for rows created
	// before this column existed — see isConventionRunning for that fallback.
	timezone: text('timezone'),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
});

// --- VR avatar showcase (SONA-124) ---

// One 3D avatar of a character. The model file may be self-hosted (`modelUrl`)
// or live off-site (`externalUrl`, e.g. a Gumroad/Booth listing) — or both.
export const vrAvatars = sqliteTable('vr_avatars', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	slug: text('slug').notNull().unique(),
	name: text('name').notNull(),
	characterId: integer('character_id').notNull().references(() => characters.id),
	// Full PUBLIC URL of the self-hosted model file — never a bare storage key.
	// The orphan sweep compares stored URLs verbatim (see referenced-urls.ts), so
	// a bare key would never match and cleanup would delete the model file as an
	// orphan. NULL = no self-hosted file (external-only entry).
	modelUrl: text('model_url'),
	modelFormat: text('model_format', { enum: ['vrm', 'vrm0', 'fbx'] }),
	modelSizeBytes: integer('model_size_bytes'),
	// Gallery image used as the showcase poster. Deleting the image just nulls
	// this out (SET NULL) rather than blocking the delete.
	posterImageId: integer('poster_image_id').references(() => images.id, { onDelete: 'set null' }),
	// Off-site home of the avatar (store page, repo, …). Inert for orphan
	// cleanup, but collected anyway per the over-collect rule.
	externalUrl: text('external_url'),
	license: text('license', { enum: ['personal-use', 'cc-by', 'base-tos', 'all-rights-reserved'] }),
	// Like fursuit_photos.permission_source: where/when permission to host the
	// model was granted (e.g. "Telegram DM 2026-08-01"). NULL = not recorded.
	permissionSource: text('permission_source'),
	downloadable: integer('downloadable', { mode: 'boolean' }).notNull().default(false),
	nsfw: integer('nsfw', { mode: 'boolean' }).notNull().default(false),
	published: integer('published', { mode: 'boolean' }).notNull().default(true),
	description: text('description'),
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
});

// Per-avatar artist credits, one row per (artist, role). `roleLabel` names the
// role when role='other' — required then, but enforced in form actions, not SQL
// (mirrors the variant one-level rule on images.parent_image_id).
export const avatarCredits = sqliteTable('avatar_credits', {
	avatarId: integer('avatar_id').notNull().references(() => vrAvatars.id, { onDelete: 'cascade' }),
	artistId: integer('artist_id').notNull().references(() => artists.id),
	role: text('role', { enum: ['base', 'modeler', 'rigger', 'texture', 'shader', 'other'] }).notNull(),
	roleLabel: text('role_label'),
	position: integer('position').notNull().default(0)
}, (table) => [
	// The public detail load fetches credits per page view by avatar_id.
	index('avatar_credits_avatar_id_idx').on(table.avatarId)
]);

// Showcase media (screenshots / clips) for an avatar, ordered by `position`.
// `url` points at our storage, so it MUST be listed in referenced-urls.ts.
export const avatarMedia = sqliteTable('avatar_media', {
	avatarId: integer('avatar_id').notNull().references(() => vrAvatars.id, { onDelete: 'cascade' }),
	kind: text('kind', { enum: ['image', 'video'] }).notNull(),
	url: text('url').notNull(),
	width: integer('width'),
	height: integer('height'),
	position: integer('position').notNull().default(0)
}, (table) => [
	// Fetched per detail-page view by avatar_id (ordered media strip).
	index('avatar_media_avatar_id_idx').on(table.avatarId)
]);

// Platforms an avatar is set up for, shown as badges. No PK, mirroring
// image_tags/sticker_emojis; form parsing dedupes and the unique index is the
// database-boundary backstop. (avatar_credits carries NO such index on
// purpose: one artist may hold several 'other' roles, distinguished only by
// role_label, and SQLite's NULL-distinct unique semantics would let every
// NULL-label duplicate through anyway — credits dedupe in parseAvatarForm.)
export const avatarPlatforms = sqliteTable('avatar_platforms', {
	avatarId: integer('avatar_id').notNull().references(() => vrAvatars.id, { onDelete: 'cascade' }),
	platform: text('platform', {
		enum: ['vrchat', 'resonite', 'chilloutvr', 'neosvr', 'vseeface', 'warudo', 'other']
	}).notNull()
}, (table) => [
	// /vr does an inArray over avatar_id for platform chips; detail fetches by it.
	index('avatar_platforms_avatar_id_idx').on(table.avatarId),
	uniqueIndex('avatar_platforms_avatar_platform_uq').on(table.avatarId, table.platform)
]);
