-- Seed OVERLAY, applied on top of fixtures/seed.sql and only for the
-- registry-sync dev server (SONA_E2E_SEED_OVERLAY, see tests/e2e/seed.ts).
--
-- A registry-linked artist that is already private (ledger_private = 1). The
-- daily sync backfill or an approved share can leave one in that state, but
-- POST /api/artists refuses to create it, so share-private-artist.spec.ts gets
-- it from here. Its Edit modal must still show "Keep private" so the owner can
-- clear the flag (SONA-236). The name and global_id are unique to this row, and
-- it has no socials, so the sync's handle backfill never searches for it.
INSERT INTO artists (name, global_id, registry_version, ledger_private, created_at)
VALUES ('Linked Private Seeded', 'e2e-linked-private-seeded', 1, 1, '2026-07-01T00:00:00.000Z');
