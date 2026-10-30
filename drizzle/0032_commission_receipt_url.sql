-- A commission entry's receipt or order link (SONA-236), such as a Ko-fi
-- order, kept beside Payment for the owner's own record. Public routes never
-- read it.
--
-- Nullable, with no backfill: every existing entry starts with no receipt
-- link. Additive only: no table is rebuilt, so no ON DELETE action fires (see
-- the table-rebuild guard test).
ALTER TABLE `commissions` ADD `receipt_url` text;
