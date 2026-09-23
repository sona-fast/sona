-- Seed OVERLAY for the passport dev server (SONA_E2E_SEED_OVERLAY, see
-- tests/e2e/seed.ts), applied on top of fixtures/seed.sql.
--
-- It switches the homepage to the passport layout, which is why it has its own
-- server: on the shared one, every spec that visits / would see the passport.
-- The shared fixture already carries what the spec reads: an NSFW ref sheet
-- designated on the owner (image 5, so the picture renders blurred), three
-- published parent pieces by one artist, four published VR avatars, two social
-- links, and one confirmed convention running today (so Here now leads). This
-- overlay adds only the data-page fields the fixture leaves blank.
INSERT OR REPLACE INTO site_settings (key, value) VALUES
  ('landingLayout', 'passport'),
  ('sonaSpecies',   'Red fox'),
  ('aboutText',     'A red fox in a blue jacket, seeded for the browser tests.');

-- A commissioned date, for the "Commissioning since" row.
UPDATE images SET commissioned_at = '2019-04-02' WHERE id = 1;
