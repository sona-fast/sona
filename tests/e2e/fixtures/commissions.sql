-- The writable commission ledger server's extra rows (SONA-236), layered on
-- seed.sql. Paste a link needs an artist with a stored handle to find: Test
-- Artist (1) gets a twitter.com profile, in a letter case the spec's x.com
-- link doesn't use, so the match has to ignore case.
UPDATE artists SET twitter_url = 'https://twitter.com/E2E_Artist' WHERE id = 1;
