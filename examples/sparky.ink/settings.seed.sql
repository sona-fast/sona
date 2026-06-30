-- Reference deployment seed: sparky.ink
--
-- Illustrative site_settings + first character for the original sparky.ink
-- deployment. A fresh Sona fork does NOT run this — it starts unbranded and the
-- owner fills these in through the first-run setup wizard / admin Settings.
-- This file documents what a configured instance looks like, and lets the
-- maintainer re-seed a demo DB.
--
-- Apply with: wrangler d1 execute <your-db> --file=examples/sparky.ink/settings.seed.sql
-- (use --local for dev, --remote for production). Safe to re-run (idempotent).

INSERT OR REPLACE INTO site_settings (key, value) VALUES
  ('siteName',          'sparky.ink'),
  ('ownerName',         'Sparky'),
  ('aboutText',         'A personal gallery for collecting and showcasing furry artwork from talented artists.'),
  ('twitterUrl',        'https://twitter.com/sparkyfen'),
  ('blueskyUrl',        'https://bsky.app/profile/sparky.social'),
  ('telegramUrl',       'https://t.me/sparkyfen'),
  ('furAffinityUrl',    'https://www.furaffinity.net/user/sparkyyy'),
  ('furtrackUrl',       'https://www.furtrack.com/user/sparkyfen'),
  ('storageProvider',   'r2'),
  ('r2PublicUrl',       'https://cdn.sparky.ink'),
  ('primaryCharacter',  'sparky'),
  ('autoResyncEnabled', 'false');

-- The single fursona the site is about. Stickers/fursuit features resolve this
-- via resolveSiteCharacterId(); one row is enough.
INSERT OR IGNORE INTO characters (name) VALUES ('Sparky');
