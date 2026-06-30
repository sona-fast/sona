PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stickers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pack_id` integer NOT NULL,
	`artist_id` integer,
	`image_url` text NOT NULL,
	`thumbnail_url` text,
	`width` integer,
	`height` integer,
	`format` text DEFAULT 'webp' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`nsfw` integer DEFAULT false NOT NULL,
	`telegram_file_unique_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `sticker_packs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_stickers`("id", "pack_id", "artist_id", "image_url", "thumbnail_url", "width", "height", "format", "position", "nsfw", "telegram_file_unique_id", "created_at") SELECT "id", "pack_id", "artist_id", "image_url", "thumbnail_url", "width", "height", "format", "position", "nsfw", "telegram_file_unique_id", "created_at" FROM `stickers`;--> statement-breakpoint
DROP TABLE `stickers`;--> statement-breakpoint
ALTER TABLE `__new_stickers` RENAME TO `stickers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;