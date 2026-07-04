ALTER TABLE `images` ADD `parent_image_id` integer REFERENCES images(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `images` ADD `variant_label` text;