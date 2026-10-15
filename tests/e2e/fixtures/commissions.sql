-- The writable commission ledger server's extra rows (SONA-236), layered on
-- seed.sql. Paste a link needs an artist with a stored handle to find: Test
-- Artist (1) gets a twitter.com profile, in a letter case the spec's x.com
-- link doesn't use, so the match has to ignore case.
UPDATE artists SET twitter_url = 'https://twitter.com/E2E_Artist' WHERE id = 1;

-- An artist whose name is a handle but who stores no link: a lookup offers them
-- as a maybe, never picks them. And two artists sharing one handle: the owner
-- picks which.
INSERT INTO artists (id, name, created_at) VALUES (50, 'name_only_artist', '2026-07-01T00:00:00.000Z');
INSERT INTO artists (id, name, twitter_url, created_at) VALUES
  (51, 'Twin One', 'https://twitter.com/twin_artist', '2026-07-01T00:00:00.000Z'),
  (52, 'Twin Two', 'https://x.com/twin_artist', '2026-07-01T00:00:00.000Z');
