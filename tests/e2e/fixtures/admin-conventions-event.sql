-- Seed OVERLAY for the admin conventions FurTrack event server
-- (SONA_E2E_SEED_OVERLAY, see tests/e2e/seed.ts), applied on top of
-- fixtures/seed.sql.
--
-- Its own server because the spec saves links and adds a convention, and the
-- shared servers are read-only by convention. Two fursuit photos carry the two
-- tags the rows can pick. Row one starts unlinked and row two linked, so a
-- refused save on row two has a saved tag to go back to. The third row is
-- linked to a tag no photo carries any more, which must still show as its value.
-- The fourth is there to be deleted through the confirm dialog.
INSERT OR REPLACE INTO conventions (id, name, location, start_date, end_date, url, status, timezone, furtrack_event, created_at)
VALUES
  (11, 'E2E Row One Con', 'Rosemont, IL', '2024-11-28', '2024-12-01',
   NULL, 'confirmed', 'America/Chicago', NULL, '2026-07-01T00:00:00.000Z'),
  (12, 'E2E Row Two Con', 'Pittsburgh, PA', '2025-07-03', '2025-07-06',
   NULL, 'confirmed', 'America/New_York', 'E2E Other Tag 2025', '2026-07-01T00:00:00.000Z'),
  (13, 'E2E Orphan Con', 'Halifax, NS', '2023-11-03', '2023-11-05',
   NULL, 'confirmed', 'America/Halifax', 'E2E Orphaned Tag 2023', '2026-07-01T00:00:00.000Z'),
  (14, 'E2E Spare Con', 'Boise, ID', '2022-05-06', '2022-05-08',
   NULL, 'maybe', 'America/Boise', NULL, '2026-07-01T00:00:00.000Z');

INSERT OR REPLACE INTO fursuit_photos
  (id, furtrack_post_id, character, image_url, photographer, event, license, furtrack_url, taken_at, created_at)
VALUES
  (1, 9101, 'E2E', '/e2e-face.png', 'E2E Lens', 'E2E Linked Tag Midwest Further Confusion 2024', 'cc-by',
   'https://www.furtrack.com/p/9101', '2024-11-30', '2026-07-01T00:00:00.000Z'),
  (2, 9102, 'E2E', '/e2e-face.png', 'E2E Lens', 'E2E Other Tag 2025', 'cc-by',
   'https://www.furtrack.com/p/9102', '2025-07-04', '2026-07-01T00:00:00.000Z');
