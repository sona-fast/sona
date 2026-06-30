CREATE TABLE `fursuit_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`furtrack_post_id` integer NOT NULL,
	`character` text NOT NULL,
	`image_url` text NOT NULL,
	`width` integer,
	`height` integer,
	`photographer` text NOT NULL,
	`photographer_url` text,
	`event` text,
	`license` text NOT NULL,
	`furtrack_url` text NOT NULL,
	`taken_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fursuit_photos_furtrack_post_id_unique` ON `fursuit_photos` (`furtrack_post_id`);