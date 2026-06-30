CREATE TABLE `characters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`owner_name` text,
	`url` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `image_characters` (
	`image_id` integer NOT NULL,
	`character_id` integer NOT NULL,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
