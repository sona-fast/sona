CREATE TABLE `avatar_credits` (
	`avatar_id` integer NOT NULL,
	`artist_id` integer NOT NULL,
	`role` text NOT NULL,
	`role_label` text,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`avatar_id`) REFERENCES `vr_avatars`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `avatar_credits_avatar_id_idx` ON `avatar_credits` (`avatar_id`);--> statement-breakpoint
CREATE TABLE `avatar_media` (
	`avatar_id` integer NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`width` integer,
	`height` integer,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`avatar_id`) REFERENCES `vr_avatars`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `avatar_media_avatar_id_idx` ON `avatar_media` (`avatar_id`);--> statement-breakpoint
CREATE TABLE `avatar_platforms` (
	`avatar_id` integer NOT NULL,
	`platform` text NOT NULL,
	FOREIGN KEY (`avatar_id`) REFERENCES `vr_avatars`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `avatar_platforms_avatar_id_idx` ON `avatar_platforms` (`avatar_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `avatar_platforms_avatar_platform_uq` ON `avatar_platforms` (`avatar_id`,`platform`);--> statement-breakpoint
CREATE TABLE `vr_avatars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`character_id` integer NOT NULL,
	`model_url` text,
	`model_format` text,
	`model_size_bytes` integer,
	`poster_image_id` integer,
	`external_url` text,
	`license` text,
	`permission_source` text,
	`downloadable` integer DEFAULT false NOT NULL,
	`nsfw` integer DEFAULT false NOT NULL,
	`published` integer DEFAULT true NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`poster_image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vr_avatars_slug_unique` ON `vr_avatars` (`slug`);