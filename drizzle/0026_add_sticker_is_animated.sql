-- SONA-123: animation flag for the download-format menu. The default (false)
-- is WRONG for animated GIF/WebP rows imported before this release — sniffing
-- needs the file bytes, which SQL can't reach. After deploying this release,
-- run POST /api/stickers/backfill-animated once (as admin) to sniff and correct
-- existing rows; see "One-time backfill" in UPDATING.md. Until then, such rows
-- may show a PNG download option; the endpoint sniffs the file's bytes and
-- serves the original (never a flattened conversion), and the backfill removes
-- the option.
ALTER TABLE `stickers` ADD `is_animated` integer DEFAULT false NOT NULL;