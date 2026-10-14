-- Commission ledger (SONA-236): the owner's private record of commissions they
-- requested. Public routes never read these tables.
--
-- commissions.artist_id has no ON DELETE: an artist with entries can't be
-- deleted, because silently deleting private payment history is worse than a
-- refused delete. Deleting a piece clears image_id and keeps its entry. The
-- unique index lets a piece link to at most one entry (NULLs stay distinct).
-- Character links cascade from both sides.
--
-- Additive only: no existing table is rebuilt, so no existing ON DELETE action
-- fires (see the table-rebuild guard test).
CREATE TABLE `commission_characters` (
	`commission_id` integer NOT NULL,
	`character_id` integer NOT NULL,
	FOREIGN KEY (`commission_id`) REFERENCES `commissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commission_characters_pair_uq` ON `commission_characters` (`commission_id`,`character_id`);--> statement-breakpoint
CREATE TABLE `commissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`artist_id` integer NOT NULL,
	`title` text NOT NULL,
	`kind` text,
	`source_url` text,
	`status` text DEFAULT 'applied' NOT NULL,
	`price_minor` integer,
	`currency` text,
	`payment` text DEFAULT 'unpaid' NOT NULL,
	`notes` text,
	`requested_on` text,
	`accepted_on` text,
	`delivered_on` text,
	`image_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `commissions_artist_id_idx` ON `commissions` (`artist_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `commissions_image_id_uq` ON `commissions` (`image_id`);