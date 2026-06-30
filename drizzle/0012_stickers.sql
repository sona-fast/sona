CREATE TABLE `sticker_emojis` (
	`sticker_id` integer NOT NULL,
	`emoji` text NOT NULL,
	FOREIGN KEY (`sticker_id`) REFERENCES `stickers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sticker_packs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`cover_image_url` text,
	`character_id` integer NOT NULL,
	`manager_artist_id` integer,
	`telegram_url` text,
	`source` text NOT NULL,
	`published` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`manager_artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sticker_packs_slug_unique` ON `sticker_packs` (`slug`);--> statement-breakpoint
CREATE TABLE `stickers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pack_id` integer NOT NULL,
	`artist_id` integer NOT NULL,
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
