-- Seed OVERLAY, applied on top of fixtures/seed.sql and only for the
-- stickers-content dev server (SONA_E2E_SEED_OVERLAY, see tests/e2e/seed.ts).
--
-- It is not part of the shared seed on purpose. nav-gating.spec.ts depends on
-- the shared fixture having ZERO sticker packs: that is what makes the header,
-- the bottom nav and the gallery tab bar render their gated state. Adding a
-- published pack there would delete that coverage, so the ungated half lives
-- here on its own database instead.
--
-- Row ids are fixed so the spec can reason about them. Character 1 (Taro) and
-- artist 1 (Test Artist) come from the base seed. Image URLs are same-origin
-- placeholder paths that 404 harmlessly, matching the image fixtures, so the
-- spec makes no external request and asserts markup rather than pixels.
INSERT OR REPLACE INTO sticker_packs
  (id, name, slug, description, cover_image_url, character_id, manager_artist_id,
   telegram_url, source, published, created_at)
VALUES
  (1, 'E2E Sticker Pack', 'e2e-pack', 'Two stickers, seeded for the browser tests.',
   NULL, 1, 1, NULL, 'self-hosted', 1, '2026-07-01T00:00:00.000Z');

-- Two stickers, both SFW and both credited to artist 1, so the pack reads as a
-- single-artist pack and the grid renders two unblurred cards.
INSERT OR REPLACE INTO stickers
  (id, pack_id, artist_id, image_url, thumbnail_url, width, height, format,
   position, nsfw, telegram_file_unique_id, created_at, is_animated)
VALUES
  (1, 1, 1, '/e2e/sticker-one.webp', '/e2e/sticker-one-thumb.webp', 512, 512, 'webp',
   0, 0, NULL, '2026-07-01T00:00:00.000Z', 0),
  (2, 1, 1, '/e2e/sticker-two.webp', '/e2e/sticker-two-thumb.webp', 512, 512, 'webp',
   1, 0, NULL, '2026-07-02T00:00:00.000Z', 0);

-- One emoji each, so the pack page's emoji rail has something to render and the
-- /stickers top-emoji rail is not empty.
INSERT INTO sticker_emojis (sticker_id, emoji) VALUES (1, '🦊'), (2, '🎉');
