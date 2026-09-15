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
  -- Pronouns for the con card's include toggle (SONA-210). The card offers no
  -- box at all when this is empty, so the toggle spec needs a value seeded.
  ('pronouns',      'they/them'),
  -- A face for the con card. Without one the card draws an initial, which is
  -- exactly the broken state this suite failed to notice for a whole release:
  -- with no avatar seeded, no e2e could tell a working embed from a silent
  -- fallback. Root-relative, so the page can read its bytes.
  ('adminAvatarUrl', '/e2e-face.png'),
  -- Recovery address for the forgot-reset spec. Inert for the other specs
  -- (nothing reads it); no adminPasswordHash is seeded, so the legacy
  -- ADMIN_PASSWORD login path other specs rely on stays authoritative.
  ('adminEmail',    'admin@e2e.test'),
  -- Seeded Instagram URL for the read-only instagram-social spec; no spec
  -- asserts on a blank social state, so this is inert for the others.
  ('instagramUrl',  'https://www.instagram.com/sona.e2e.example'),
  -- A deep link on a platform with a profile prefix, for the same spec: its
  -- label is the account (@sona.e2e.example), not the last path segment
  -- ("gallery") the old per-page helpers took (SONA-128).
  ('furAffinityUrl', 'https://www.furaffinity.net/user/sona.e2e.example/gallery');

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

-- Untagged images with a Bluesky or X source post, for the suggest-tags spec
-- (SONA-220). UNPUBLISHED, like image 4, so the gallery specs' counts stay
-- untouched; the backfill page lists by source URL and tags alone. Twenty-eight
-- of them: one page is twenty, so "Load more" has a second page to grow into,
-- and the extra rows are the spec's reserve. The spec's save tests take three
-- rows off the list for good, and a retry of that serial file starts from what
-- is left: at twenty-three the retry began with exactly one page and the Load
-- more test had nothing to grow, so it skipped every time it was retried.
-- Ids start at 96 to stay clear of the fixtures above; the list orders by id,
-- so the reserve sits at the bottom and the rows the spec works on keep their
-- places. The spec saves tags on some of these rows, which is why it runs on
-- its own seeded server.
INSERT OR REPLACE INTO images
  (id, title, slug, image_url, thumbnail_url, width, height, nsfw, published, artist_id, source_post_url, created_at)
VALUES
  (96, 'Backfill 96', 'backfill-96', '/e2e/backfill-96.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc096', '2026-07-06T00:00:36.000Z'),
  (97, 'Backfill 97', 'backfill-97', '/e2e/backfill-97.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc097', '2026-07-06T00:00:37.000Z'),
  (98, 'Backfill 98', 'backfill-98', '/e2e/backfill-98.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc098', '2026-07-06T00:00:38.000Z'),
  (99, 'Backfill 99', 'backfill-99', '/e2e/backfill-99.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc099', '2026-07-06T00:00:39.000Z'),
  (100, 'Backfill 100', 'backfill-100', '/e2e/backfill-100.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc100', '2026-07-06T00:00:40.000Z'),
  (101, 'Backfill 101', 'backfill-101', '/e2e/backfill-101.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc101', '2026-07-06T00:00:41.000Z'),
  (102, 'Backfill 102', 'backfill-102', '/e2e/backfill-102.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc102', '2026-07-06T00:00:42.000Z'),
  (103, 'Backfill 103', 'backfill-103', '/e2e/backfill-103.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc103', '2026-07-06T00:00:43.000Z'),
  (104, 'Backfill 104', 'backfill-104', '/e2e/backfill-104.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc104', '2026-07-06T00:00:44.000Z'),
  (105, 'Backfill 105', 'backfill-105', '/e2e/backfill-105.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc105', '2026-07-06T00:00:45.000Z'),
  (106, 'Backfill 106', 'backfill-106', '/e2e/backfill-106.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc106', '2026-07-06T00:00:46.000Z'),
  (107, 'Backfill 107', 'backfill-107', '/e2e/backfill-107.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc107', '2026-07-06T00:00:47.000Z'),
  (108, 'Backfill 108', 'backfill-108', '/e2e/backfill-108.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc108', '2026-07-06T00:00:48.000Z'),
  (109, 'Backfill 109', 'backfill-109', '/e2e/backfill-109.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc109', '2026-07-06T00:00:49.000Z'),
  (110, 'Backfill 110', 'backfill-110', '/e2e/backfill-110.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc110', '2026-07-06T00:00:50.000Z'),
  (111, 'Backfill 111', 'backfill-111', '/e2e/backfill-111.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc111', '2026-07-06T00:00:51.000Z'),
  (112, 'Backfill 112', 'backfill-112', '/e2e/backfill-112.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc112', '2026-07-06T00:00:52.000Z'),
  (113, 'Backfill 113', 'backfill-113', '/e2e/backfill-113.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc113', '2026-07-06T00:00:53.000Z'),
  (114, 'Backfill 114', 'backfill-114', '/e2e/backfill-114.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc114', '2026-07-06T00:00:54.000Z'),
  (115, 'Backfill 115', 'backfill-115', '/e2e/backfill-115.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc115', '2026-07-06T00:00:55.000Z'),
  (116, 'Backfill 116', 'backfill-116', '/e2e/backfill-116.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc116', '2026-07-06T00:00:56.000Z'),
  (117, 'Backfill 117', 'backfill-117', '/e2e/backfill-117.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc117', '2026-07-06T00:00:57.000Z'),
  (118, 'Backfill 118', 'backfill-118', '/e2e/backfill-118.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc118', '2026-07-06T00:00:58.000Z'),
  (119, 'Backfill 119', 'backfill-119', '/e2e/backfill-119.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc119', '2026-07-06T00:00:59.000Z'),
  (120, 'Backfill 120', 'backfill-120', '/e2e/backfill-120.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc120', '2026-07-06T00:00:00.000Z'),
  (121, 'Backfill 121', 'backfill-121', '/e2e/backfill-121.png', NULL, 900, 700, 0, 0, 1, 'https://bsky.app/profile/e2e.example/post/3kq7x2abc121', '2026-07-06T00:00:01.000Z'),
  (122, 'Backfill 122', 'backfill-122', '/e2e/backfill-122.png', NULL, 900, 700, 0, 0, 1, 'https://x.com/e2e_artist/status/1834455667788990122', '2026-07-06T00:00:02.000Z'),
  (123, 'Backfill 123', 'backfill-123', '/e2e/backfill-123.png', NULL, 900, 700, 0, 0, 1, 'https://x.com/e2e_artist/status/1834455667788990123', '2026-07-06T00:00:03.000Z');

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

-- One convention running RIGHT NOW, so /connect renders its here-now block in a
-- browser (SONA-210). Dated off date('now') like the rollups above, with a day
-- either side: the block is decided server-side from the real clock, so a fixed
-- date would stop being live the day after it was written. Confirmed, because a
-- 'maybe' row never counts as live, and zoned, because start/end are bare
-- calendar dates and "is it running" is asked in the event's own timezone.
INSERT OR REPLACE INTO conventions (id, name, location, start_date, end_date, url, status, timezone, created_at)
VALUES
  (1, 'E2E Live Con', 'Denver, CO', date('now', '-1 day'), date('now', '+1 day'),
   NULL, 'confirmed', 'America/Denver', '2026-07-01T00:00:00.000Z');
