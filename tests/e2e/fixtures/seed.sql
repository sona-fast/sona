-- E2E seed fixture. Applied by tests/e2e/seed.ts to a throwaway local D1 after
-- migrations, before the dev server boots. Keep it minimal: just enough for the
-- gallery specs. Row ids are fixed so specs can reason about them. (INSERT OR
-- REPLACE is used defensively; seed.ts wipes the DB first, so it never collides.)

-- Site must be past first-run setup or hooks.server.ts redirects every route to
-- /admin/setup. setupComplete=true is the gate; the rest gives the chrome a name.
INSERT OR REPLACE INTO site_settings (key, value) VALUES
  ('setupComplete', 'true'),
  ('siteName',      'E2E Test Gallery'),
  ('ownerName',     'E2E'),
  -- Recovery address for the forgot-reset spec. Inert for the other specs
  -- (nothing reads it); no adminPasswordHash is seeded, so the legacy
  -- ADMIN_PASSWORD login path other specs rely on stays authoritative.
  ('adminEmail',    'admin@e2e.test'),
  -- Seeded Instagram URL for the read-only instagram-social spec; no spec
  -- asserts on a blank social state, so this is inert for the others.
  ('instagramUrl',  'https://www.instagram.com/sona.e2e.example');

-- One artist for the images to credit.
INSERT OR REPLACE INTO artists (id, name, created_at)
VALUES (1, 'Test Artist', '2026-07-01T00:00:00.000Z');

-- Artist WITH an avatar image for the admin avatar-geometry spec (SONA-148).
-- The URL must actually load (a 404 flips ArtistAvatar to its monogram
-- fallback), so it points at a committed static asset dedicated to this seed
-- (static/e2e-avatar.svg) rather than a branding asset forks may rename. The
-- name is disjoint from 'Test Artist' so ?q=Avatar renders a list with no
-- monogram rows — the geometry bug only reproduces then.
INSERT OR REPLACE INTO artists (id, name, avatar_url, created_at)
VALUES (2, 'Avatar Artist', '/e2e-avatar.svg', '2026-07-01T00:00:00.000Z');

-- Variant group: a published SFW parent + a published NSFW variant that points
-- at it via parent_image_id. The gallery variant strip renders both, and the
-- NSFW sibling must arrive blurred. Image URLs are same-origin placeholder paths
-- (they 404 harmlessly) so the tests make NO external network calls — the
-- distinct `parentpiece` / `variantpiece` tokens let specs assert the shown
-- image follows the URL.
INSERT OR REPLACE INTO images
  (id, title, slug, image_url, thumbnail_url, width, height, nsfw, published, artist_id, parent_image_id, variant_label, created_at)
VALUES
  (1, 'Parent Piece SFW', 'parent-piece',
   '/e2e/parentpiece.png', '/e2e/parentpiece-thumb.png',
   900, 700, 0, 1, 1, NULL, NULL, '2026-07-01T00:00:00.000Z'),
  (2, 'Variant Piece NSFW', 'variant-piece',
   '/e2e/variantpiece.png', '/e2e/variantpiece-thumb.png',
   900, 700, 1, 1, 1, 1, 'Alt', '2026-07-02T00:00:00.000Z');

-- Reference sheet for the admin palette-picker spec: a published image tagged
-- 'reference' (resolveRefImage's fallback path). Like the gallery fixtures its
-- URL is a same-origin placeholder that 404s harmlessly -- the palette specs
-- assert dialog/input behavior, never canvas pixels.
INSERT OR REPLACE INTO images
  (id, title, slug, image_url, thumbnail_url, width, height, nsfw, published, artist_id, parent_image_id, variant_label, created_at)
VALUES
  (3, 'Ref Sheet', 'ref-sheet',
   '/e2e/refsheet.png', '/e2e/refsheet-thumb.png',
   1200, 900, 0, 1, 1, NULL, NULL, '2026-07-03T00:00:00.000Z');
INSERT OR REPLACE INTO tags (id, name, created_at) VALUES (1, 'reference', '2026-07-01T00:00:00.000Z');
INSERT OR REPLACE INTO image_tags (image_id, tag_id) VALUES (3, 1);

-- Tier-A visitor rollups for the observability spec (#193): enough pageview /
-- device / referrer / country counters (dated today, inside the dashboard
-- window) that /admin/observability renders every percentage-bar list with a
-- non-zero share. Counters only — no per-visitor rows, mirroring production.
INSERT OR REPLACE INTO metric_rollup (day, metric, dim, count) VALUES
  (date('now'), 'pageview', '/', 30),
  (date('now'), 'pageview', '/art', 10),
  (date('now'), 'device', 'desktop', 20),
  (date('now'), 'device', 'mobile', 15),
  (date('now'), 'device', 'tablet', 5),
  (date('now'), 'referrer', 'example.com', 8),
  (date('now'), 'country', 'US', 25);
