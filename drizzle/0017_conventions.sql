CREATE TABLE `conventions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`location` text,
	`start_date` text NOT NULL,
	`end_date` text,
	`url` text,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`source_id` text,
	`created_at` text NOT NULL
);
