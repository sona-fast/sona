-- Seed OVERLAY, applied on top of fixtures/seed.sql and only for the
-- sticker-modal dev server (SONA_E2E_SEED_OVERLAY, see tests/e2e/seed.ts).
--
-- The modal needs a pack with enough stickers to page through: a middle, two
-- ends, a filtered subset, and two NSFW stickers side by side. It gets its own
-- database rather than growing the stickers-content pack, because that spec
-- counts the pack's stickers and the /stickers pack list, and both counts
-- would change.
--
-- Row ids are fixed so the spec can reason about them. Character 1 (Taro) and
-- artist 1 (Test Artist) come from the base seed. Image URLs are same-origin
-- placeholder paths that 404 on the dev server; sticker-modal.spec.ts serves an
-- SVG for them so its screenshots show art.
INSERT OR REPLACE INTO sticker_packs
  (id, name, slug, description, cover_image_url, character_id, manager_artist_id,
   telegram_url, source, published, created_at)
VALUES
  (1, 'E2E Sticker Pack', 'e2e-pack', 'Six stickers, seeded for the sticker modal tests.',
   NULL, 1, 1, NULL, 'self-hosted', 1, '2026-07-01T00:00:00.000Z');

-- Six stickers, all credited to artist 1, so the pack reads as a single-artist
-- pack. Stickers 4 and 5 are NSFW and sit next to each other, so the spec can
-- reveal one and page straight to the other.
INSERT OR REPLACE INTO stickers
  (id, pack_id, artist_id, image_url, thumbnail_url, width, height, format,
   position, nsfw, telegram_file_unique_id, created_at, is_animated)
VALUES
  (1, 1, 1, '/e2e/sticker-one.webp', '/e2e/sticker-one-thumb.webp', 512, 512, 'webp',
   0, 0, NULL, '2026-07-01T00:00:00.000Z', 0),
  (2, 1, 1, '/e2e/sticker-two.webp', '/e2e/sticker-two-thumb.webp', 512, 512, 'webp',
   1, 0, NULL, '2026-07-02T00:00:00.000Z', 0),
  (3, 1, 1, '/e2e/sticker-three.webp', '/e2e/sticker-three-thumb.webp', 512, 512, 'webp',
   2, 0, NULL, '2026-07-03T00:00:00.000Z', 0),
  (4, 1, 1, '/e2e/sticker-four.webp', '/e2e/sticker-four-thumb.webp', 512, 512, 'webp',
   3, 1, NULL, '2026-07-04T00:00:00.000Z', 0),
  (5, 1, 1, '/e2e/sticker-five.webp', '/e2e/sticker-five-thumb.webp', 512, 512, 'webp',
   4, 1, NULL, '2026-07-05T00:00:00.000Z', 0),
  (6, 1, 1, '/e2e/sticker-six.webp', '/e2e/sticker-six-thumb.webp', 512, 512, 'webp',
   5, 0, NULL, '2026-07-06T00:00:00.000Z', 0);

-- 😊 tags stickers 1, 3, 4 and 5, so filtering by it leaves four of the six,
-- and the modal pages through those.
INSERT INTO sticker_emojis (sticker_id, emoji) VALUES
  (1, '🦊'), (1, '😊'), (2, '🎉'), (3, '😊'), (4, '😊'), (5, '😊'), (6, '🌙');
