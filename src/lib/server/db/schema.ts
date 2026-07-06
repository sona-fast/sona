import { sqliteTable, text, integer, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

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
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
});

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
	// an operator from the gallery. NULL = none set; the About page then falls back
	// to the fetched Bluesky avatar. Kept nullable so clearing it is a no-op; the
	// image being deleted just nulls this out (SET NULL) rather than blocking it.
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
// "single vs multi" flag — shape is derived. See examples/sparky.ink/stickers-design-brief.md.
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
	createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString())
});
