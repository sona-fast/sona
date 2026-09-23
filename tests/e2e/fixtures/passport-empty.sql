-- Seed OVERLAY for the fresh-site passport server (SONA_E2E_SEED_OVERLAY, see
-- tests/e2e/seed.ts), applied on top of fixtures/seed.sql.
--
-- A fresh fork: a profile picture, the owner name, the host, and nothing a
-- stamp could point at. The shared fixture's content is unpublished or removed
-- here rather than left out of seed.sql, so every other server keeps it.
INSERT OR REPLACE INTO site_settings (key, value) VALUES ('landingLayout', 'passport');

-- No socials and no pronouns: the Elsewhere and Pronouns rows and the About
-- stamp all hide.
DELETE FROM site_settings WHERE key IN ('instagramUrl', 'furAffinityUrl', 'pronouns');

-- No published piece (so no gallery stamp and no ref sheet: the admin avatar
-- fills the frame), no published VR avatar, and no convention.
UPDATE images SET published = 0;
UPDATE vr_avatars SET published = 0;
DELETE FROM conventions;
