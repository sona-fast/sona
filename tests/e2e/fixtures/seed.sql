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

-- NSFW poster source for VR avatar 3 (the inherited-flag spec). UNPUBLISHED so
-- it never appears in the gallery grid or variant strips (the gallery specs'
-- counts stay untouched); the VR poster join deliberately ignores published,
-- so it still renders — blurred — as the avatar's poster.
INSERT OR REPLACE INTO images
  (id, title, slug, image_url, thumbnail_url, width, height, nsfw, published, artist_id, parent_image_id, variant_label, created_at)
VALUES
  (4, 'Mature Poster Source', 'mature-poster-source',
   '/e2e/matureposter.png', '/e2e/matureposter-thumb.png',
   900, 700, 1, 0, 1, NULL, NULL, '2026-07-04T00:00:00.000Z');

-- VR avatar fixtures for the vr-avatar spec (SONA-124). Characters to satisfy
-- the FK (see the note on their names below), one PUBLISHED avatar with a
-- self-hosted model whose license
-- is restrictive (all-rights-reserved: the download route must 403 even with
-- downloadable=1 AND a recorded permission source — the flag and the grant
-- can't override the license, and the model bytes are never fetched so no R2
-- object is needed; the recorded source also keeps the row saveable through
-- the admin edit form, which 400s on downloadable-without-source), and one
-- UNPUBLISHED draft that must stay invisible publicly. The model URL is a
-- same-origin placeholder path, like the image fixtures — the spec never
-- loads the 3D view. Avatar 3 is a PUBLISHED avatar whose own nsfw=0 but
-- whose poster (image 4) is NSFW: the loaders' inherited flag must blur its
-- card and mature-gate its detail page. It shares avatar 1's model key (one
-- R2 stub serves both HEAD probes) so the 3D entry point exists to gate.
-- Two characters, because one named 'Taro' was byte-identical to the avatar
-- name placeholder's old hardcoded example: any assertion on it passed against
-- pre-change code. Character 2 is the SITE'S OWN sona (is_owner) and sorts
-- AFTER Taro by name, so the placeholder can only read 'Thistle' if the form
-- resolves the owner rather than the stock name or the first row by name.
INSERT OR REPLACE INTO characters (id, name, is_owner, created_at)
VALUES
  (1, 'Taro', 0, '2026-07-01T00:00:00.000Z'),
  (2, 'Thistle', 1, '2026-07-01T00:00:00.000Z');

-- NSFW reference sheet for the /art shield spec (SONA-18): published,
-- non-variant, and designated on the OWNER character, so it exercises the
-- explicit reference_image_id path rather than the REFERENCE_TAG fallback.
-- Same-origin placeholder URL like its siblings, so the spec makes no external
-- request and asserts markup, never pixels. It outranks image 3 for every
-- consumer of the designation — the palette picker included, which only needs
-- SOME ref sheet to exist for its dialog to open.
INSERT OR REPLACE INTO images
  (id, title, slug, image_url, thumbnail_url, width, height, nsfw, published, artist_id, parent_image_id, variant_label, created_at)
VALUES
  (5, 'Mature Ref Sheet', 'mature-ref-sheet',
   '/e2e/matureref.png', '/e2e/matureref-thumb.png',
   1200, 900, 1, 1, 1, NULL, NULL, '2026-07-05T00:00:00.000Z');
UPDATE characters SET reference_image_id = 5 WHERE id = 2;
INSERT OR REPLACE INTO vr_avatars
  (id, slug, name, character_id, model_url, model_format, model_size_bytes, poster_image_id,
   external_url, license, permission_source, downloadable, nsfw, published, description, created_at)
VALUES
  (1, 'e2e-avatar', 'E2E VR Avatar', 1, '/img/vr-models/e2e-avatar.vrm', 'vrm', 1234567, 1,
   NULL, 'all-rights-reserved', 'e2e fixture grant', 1, 0, 1, NULL, '2026-07-01T00:00:00.000Z'),
  (2, 'e2e-draft', 'E2E VR Draft', 1, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, 0, 0, 0, NULL, '2026-07-02T00:00:00.000Z'),
  (3, 'e2e-mature-poster', 'E2E Mature Poster', 1, '/img/vr-models/e2e-avatar.vrm', 'vrm', 1234567, 4,
   NULL, NULL, NULL, 0, 0, 1, NULL, '2026-06-30T00:00:00.000Z');

-- Avatar 4 backs the vr-render spec: unlike avatar 1's 47-byte text stub, its
-- model key serves the committed REAL fixture (tests/e2e/fixtures/
-- e2e-textured.vrm, seeded into R2 by seed.ts) so the spec can click through
-- "View in 3D" and drive the actual GLTFLoader + three-vrm texture path.
-- Kept separate from e2e-avatar on purpose — the other specs depend on that
-- slug's exact stub behavior. model_size_bytes matches the committed fixture;
-- it only drives the loading-progress display, so drift is cosmetic. Poster
-- reuses image 1 (SFW, published); no download fields so no download button.
INSERT OR REPLACE INTO vr_avatars
  (id, slug, name, character_id, model_url, model_format, model_size_bytes, poster_image_id,
   external_url, license, permission_source, downloadable, nsfw, published, description, created_at)
VALUES
  (4, 'e2e-textured', 'E2E Textured Avatar', 1, '/img/vr-models/e2e-textured.vrm', 'vrm', 3224, 1,
   NULL, NULL, NULL, 0, 0, 1, NULL, '2026-06-29T00:00:00.000Z');
INSERT OR REPLACE INTO avatar_platforms (avatar_id, platform) VALUES (1, 'vrchat');

-- Showcase media for avatar 1 (SONA-124 SP1): one image + one clip so the
-- public detail page's media strip renders (poster thumb + these two). URLs
-- are same-origin placeholders that 404 harmlessly, like the image fixtures.
INSERT OR REPLACE INTO avatar_media (avatar_id, kind, url, width, height, position) VALUES
  (1, 'image', '/e2e/vr-media-shot.png', 900, 700, 0),
  (1, 'video', '/e2e/vr-media-clip.webm', 640, 360, 1);

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
