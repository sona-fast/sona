-- Seed OVERLAY for the passport dev server (SONA_E2E_SEED_OVERLAY, see
-- tests/e2e/seed.ts), applied on top of fixtures/seed.sql.
--
-- It switches the homepage to the passport layout, which is why it has its own
-- server: on the shared one, every spec that visits / would see the passport.
-- The shared fixture already carries most of what the spec reads: an NSFW ref
-- sheet designated on the owner (image 5, so the picture renders blurred),
-- three published parent pieces by one artist, four published VR avatars, two
-- social links, and one confirmed convention running today (so Here now
-- leads). This overlay adds the data-page fields the fixture leaves blank, and
-- one row for each stamp shape the fixture can't reach: an upcoming confirmed
-- convention (the dashed Next stamp) and a fursuit photo with an event (the
-- fursuit rectangle and a past-event stamp; this server runs FurTrack in mock
-- mode, see wrangler.e2e-passport.toml).
INSERT OR REPLACE INTO site_settings (key, value) VALUES
  ('landingLayout', 'passport'),
  ('sonaSpecies',   'Red fox'),
  ('aboutText',     'A red fox in a blue jacket, seeded for the browser tests.');

-- A commissioned date, for the "Commissioning since" row.
UPDATE images SET commissioned_at = '2019-04-02' WHERE id = 1;

-- The ref sheet points at a real static image, so the picture loads rather than
-- 404s. Not the admin avatar's file: the spec tells the two apart in og:image.
UPDATE images SET image_url = '/e2e-avatar.svg' WHERE id = 5;

INSERT OR REPLACE INTO conventions (id, name, location, start_date, end_date, url, status, timezone, created_at)
VALUES
  (2, 'E2E Next Con', 'Portland, OR', date('now', '+60 days'), date('now', '+62 days'),
   NULL, 'confirmed', 'America/Los_Angeles', '2026-07-01T00:00:00.000Z');

INSERT OR REPLACE INTO fursuit_photos
  (id, furtrack_post_id, character, image_url, photographer, event, license, furtrack_url, taken_at, created_at)
VALUES
  (1, 9001, 'E2E', '/e2e-face.png', 'E2E Lens', 'E2E Past Con 2025', 'cc-by',
   'https://www.furtrack.com/p/9001', '2025-06-14', '2026-07-01T00:00:00.000Z');
