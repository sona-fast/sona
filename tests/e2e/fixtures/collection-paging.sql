-- Seed OVERLAY, applied on top of fixtures/seed.sql and only for the
-- collection-paging dev server (SONA_E2E_SEED_OVERLAY, see tests/e2e/seed.ts).
--
-- A piece opened from a collection pages through that collection (SONA-179).
-- The shared fixture has no collections, and nav-gating.spec.ts asserts the
-- Collections link stays hidden there, so this gets its own database.
--
-- The collection holds three of the four published grid pieces, newest first:
-- Mature Ref Sheet (07-05, NSFW), Parent Piece SFW (07-01), and Collection
-- Piece (06-20, added here). Ref Sheet (07-03) stays out, so the gallery's
-- order (Mature Ref Sheet, Ref Sheet, Parent Piece SFW, Collection Piece) and
-- the collection's differ right after the first piece. A draft in the
-- collection must never show up. Artist 1 (Test Artist) comes from the base
-- seed. The thumbnail key follows the '/img/e2e/<name>-thumb.png' pattern, so
-- seed.ts puts the committed PNG under it.
--
-- Variant Piece NSFW (2), a version of Parent Piece SFW, is filed in a second
-- collection on its own row. A version follows its original's collection, so
-- its page must name E2E Collection, never E2E Other Collection. Collection
-- grids list only originals, so the other collection's grid stays empty.
INSERT OR REPLACE INTO collections (id, name, slug, cover_image_url, created_at)
VALUES
  (1, 'E2E Collection', 'e2e-collection', NULL, '2026-07-01T00:00:00.000Z'),
  (2, 'E2E Other Collection', 'e2e-other-collection', NULL, '2026-07-02T00:00:00.000Z');

INSERT OR REPLACE INTO images
  (id, title, slug, image_url, thumbnail_url, width, height, nsfw, published, artist_id, parent_image_id, variant_label, collection_id, created_at)
VALUES
  (20, 'Collection Piece', 'collection-piece',
   '/e2e/collectionpiece.png', '/img/e2e/collectionpiece-thumb.png',
   900, 700, 0, 1, 1, NULL, NULL, 1, '2026-06-20T00:00:00.000Z'),
  (21, 'Collection Draft', 'collection-draft',
   '/e2e/collectiondraft.png', '/img/e2e/collectiondraft-thumb.png',
   900, 700, 0, 0, 1, NULL, NULL, 1, '2026-07-02T00:00:00.000Z');

UPDATE images SET collection_id = 1 WHERE id IN (1, 5);
UPDATE images SET collection_id = 2 WHERE id = 2;
