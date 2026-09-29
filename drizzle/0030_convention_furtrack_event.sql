-- The fursuit photos' event tag (fursuit_photos.event) that this convention is,
-- picked once per convention by the operator in admin. Nothing matches it
-- automatically: an annual convention keeps its name every year, so the name
-- alone cannot tell this year's photos from last year's, and only the tag can.
--
-- Stored exactly as the photos store it, untrimmed: the gallery's event filter
-- and the passport's event groups compare the stored value exactly.
--
-- Nullable, with no backfill: every existing row starts unlinked, and an
-- unlinked convention behaves exactly as before. The unique index keeps one tag
-- to at most one convention; SQLite treats NULLs as distinct, so any number of
-- rows can stay unlinked.
ALTER TABLE `conventions` ADD `furtrack_event` text;--> statement-breakpoint
CREATE UNIQUE INDEX `conventions_furtrack_event_unique` ON `conventions` (`furtrack_event`);
