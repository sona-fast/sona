ALTER TABLE `characters` ADD `is_owner` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill existing forks (e.g. akito.dog, taro.surf) whose first sticker import
-- auto-created an "owner" character to satisfy stickers.character_id. That row is
-- the only character on a fresh fork, it owns the sticker pack(s), and — because
-- the fork had no art yet — it is not attached to any image. Flag exactly those:
-- a character referenced by a sticker pack AND absent from image_characters. A
-- legitimately-featured character appears in the art (has image_characters rows),
-- so this can never flag one; sparky.ink's real fursona is therefore untouched.
UPDATE `characters` SET `is_owner` = true
WHERE `id` IN (SELECT `character_id` FROM `sticker_packs`)
  AND `id` NOT IN (SELECT `character_id` FROM `image_characters`);
