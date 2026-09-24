-- Seed OVERLAY for the passport dev server (SONA_E2E_SEED_OVERLAY, see
-- tests/e2e/seed.ts), applied on top of fixtures/seed.sql.
--
-- It switches the homepage to the passport layout, which is why it has its own
-- server: on the shared one, every spec that visits / would see the passport.
-- The shared fixture already carries most of what the spec reads: three
-- published parent pieces by one artist (image 5 NSFW), four published VR
-- avatars, two social links, and one confirmed convention running today (so
-- Here now leads). This overlay adds the data-page fields the fixture leaves
-- blank, the passport picture's pool, and one row for each stamp shape the
-- fixture can't reach: an upcoming confirmed convention (the dashed Next
-- stamp) and a fursuit photo with an event (the fursuit rectangle and a
-- past-event stamp; this server runs FurTrack in mock mode, see
-- wrangler.e2e-passport.toml).
INSERT OR REPLACE INTO site_settings (key, value) VALUES
  ('landingLayout', 'passport'),
  ('sonaSpecies',   'Red fox'),
  ('aboutText',     'A red fox in a blue jacket, seeded for the browser tests.');

-- A commissioned date, for the "Commissioning since" row.
UPDATE images SET commissioned_at = '2019-04-02' WHERE id = 1;

-- The picture pool holds exactly one piece, so the picture of the day is the
-- same on every day the suite runs. Image 6 is tagged only with the owner
-- character (Thistle), which keeps it in the pool. The other rows are here for
-- realism, not as a test of the pool rules: this spec would still see image 6
-- on most days if the loader let images 1 and 3 (tagged with Taro, who is not
-- the owner), 5 (NSFW) or 2 (a variant) in. The loader unit tests in
-- src/routes/(public)/page.server.test.ts own those rules. Image 6 points at a
-- real static image, so the picture loads rather than 404s, and not the admin
-- avatar's file: the spec tells the two apart in og:image.
INSERT OR REPLACE INTO images
  (id, title, slug, image_url, thumbnail_url, width, height, nsfw, published, artist_id, parent_image_id, variant_label, created_at)
VALUES
  (6, 'E2E Daily Piece', 'e2e-daily-piece',
   '/e2e-avatar.svg', NULL, 900, 1200, 0, 1, 1, NULL, NULL, '2026-07-06T00:00:00.000Z');
INSERT INTO image_characters (image_id, character_id) VALUES (6, 2), (3, 1), (1, 1), (1, 2);

INSERT OR REPLACE INTO conventions (id, name, location, start_date, end_date, url, status, timezone, created_at)
VALUES
  (2, 'E2E Next Con', 'Portland, OR', date('now', '+60 days'), date('now', '+62 days'),
   NULL, 'confirmed', 'America/Los_Angeles', '2026-07-01T00:00:00.000Z');

INSERT OR REPLACE INTO fursuit_photos
  (id, furtrack_post_id, character, image_url, photographer, event, license, furtrack_url, taken_at, created_at)
VALUES
  (1, 9001, 'E2E', '/e2e-face.png', 'E2E Lens', 'E2E Past Con 2025', 'cc-by',
   'https://www.furtrack.com/p/9001', '2025-06-14', '2026-07-01T00:00:00.000Z');
