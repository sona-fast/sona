-- Staging seed. Synthetic data only — load into the sona-staging D1 AFTER the
-- migrations run (see docs/staging.md). Adapted from tests/e2e/fixtures/seed.sql.
-- Everything here is fake: a placeholder artist, same-origin placeholder image
-- URLs (they 404 harmlessly, so no external network calls), and a marked
-- admin-hash placeholder the operator MUST replace before the DB is usable.

-- Site is past first-run setup so hooks.server.ts serves normal routes instead
-- of redirecting everything to /admin/setup.
INSERT OR REPLACE INTO site_settings (key, value) VALUES
  ('setupComplete', 'true'),
  ('siteName',      'Sona Staging'),
  ('ownerName',     'Staging'),
  ('adminEmail',    'staging@example.invalid');

-- Admin login credential. This is a PLACEHOLDER, not a working hash — logging in
-- with it is impossible until you replace it. Generate a real hash for a password
-- you choose and substitute it (see docs/staging.md "Seed generation + load"):
--
--   echo -n 'your-staging-password' | npx tsx scripts/hash-admin-password.ts
--
-- then replace the value below with the printed pbkdf2$... string (or sed it in
-- at load time). Never commit a real password's hash to the repo.
--
-- WARNING: loading this seed WITHOUT the substitution is a silent admin lockout —
-- setupComplete=true skips the wizard, but no password verifies against the
-- placeholder, so /admin/login rejects every attempt. Recover with
-- `npm run reset-password` or the wizard-reset block in docs/staging.md.
INSERT OR REPLACE INTO site_settings (key, value) VALUES
  ('adminPasswordHash', 'REPLACE_ME_WITH_pbkdf2_HASH');

-- One synthetic artist to credit the placeholder images.
INSERT OR REPLACE INTO artists (id, name, created_at)
VALUES (1, 'Staging Artist', '2026-07-01T00:00:00.000Z');

-- A published SFW parent + a published NSFW variant pointing at it, mirroring the
-- e2e fixture so the gallery/variant surfaces have something to render. URLs are
-- same-origin placeholders that 404 harmlessly.
INSERT OR REPLACE INTO images
  (id, title, slug, image_url, thumbnail_url, width, height, nsfw, published, artist_id, parent_image_id, variant_label, created_at)
VALUES
  (1, 'Parent Piece SFW', 'parent-piece',
   '/staging/parentpiece.png', '/staging/parentpiece-thumb.png',
   900, 700, 0, 1, 1, NULL, NULL, '2026-07-01T00:00:00.000Z'),
  (2, 'Variant Piece NSFW', 'variant-piece',
   '/staging/variantpiece.png', '/staging/variantpiece-thumb.png',
   900, 700, 1, 1, 1, 1, 'Alt', '2026-07-02T00:00:00.000Z');

-- A published reference sheet (tagged 'reference') for the admin palette-picker.
INSERT OR REPLACE INTO images
  (id, title, slug, image_url, thumbnail_url, width, height, nsfw, published, artist_id, parent_image_id, variant_label, created_at)
VALUES
  (3, 'Ref Sheet', 'ref-sheet',
   '/staging/refsheet.png', '/staging/refsheet-thumb.png',
   1200, 900, 0, 1, 1, NULL, NULL, '2026-07-03T00:00:00.000Z');
INSERT OR REPLACE INTO tags (id, name, created_at) VALUES (1, 'reference', '2026-07-01T00:00:00.000Z');
INSERT OR REPLACE INTO image_tags (image_id, tag_id) VALUES (3, 1);
