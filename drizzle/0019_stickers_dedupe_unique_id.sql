-- Dedupe telegram_file_unique_id, then enforce it with a UNIQUE index.
--
-- Two concurrent imports of the same Telegram set could double-insert a sticker:
-- both snapshot the existing-ids set before either writes, so the app-level dedupe
-- check races and the same telegram_file_unique_id lands twice. Before we can add
-- the UNIQUE index, any such existing duplicates (produced by past double-imports
-- on prod DBs — sparky.ink, akito.dog, taro.surf) must be removed, or the CREATE
-- INDEX would fail. This deletes ONLY genuine duplicates: for each
-- telegram_file_unique_id we keep the lowest id and drop the rest (and their
-- sticker_emojis rows). Self-hosted stickers have a NULL id and are never touched.
DELETE FROM `sticker_emojis`
WHERE `sticker_id` IN (
	SELECT `id` FROM `stickers`
	WHERE `telegram_file_unique_id` IS NOT NULL
	  AND `id` NOT IN (
		SELECT MIN(`id`) FROM `stickers`
		WHERE `telegram_file_unique_id` IS NOT NULL
		GROUP BY `telegram_file_unique_id`
	  )
);--> statement-breakpoint
DELETE FROM `stickers`
WHERE `telegram_file_unique_id` IS NOT NULL
  AND `id` NOT IN (
	SELECT MIN(`id`) FROM `stickers`
	WHERE `telegram_file_unique_id` IS NOT NULL
	GROUP BY `telegram_file_unique_id`
  );--> statement-breakpoint
CREATE UNIQUE INDEX `stickers_telegram_file_unique_id_unique` ON `stickers` (`telegram_file_unique_id`);
