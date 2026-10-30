-- One commission ledger entry for the gated ledger spec (SONA-236), layered on
-- seed.sql: artist 1 (Test Artist) and character 1 (Taro) come from there. Two
-- dates, so the read-only entry page shows both as plain dates. Private fields
-- are placeholders, never real chat links or notes.
INSERT INTO commissions (id, artist_id, title, kind, source_url, status, payment, receipt_url, price_minor, currency, notes,
  requested_on, accepted_on, delivered_on, created_at, updated_at)
VALUES (1, 1, 'Headshot icon', 'Icon', 'https://example.com/opening', 'delivered', 'paid', 'https://example.com/receipt/1', 4500, 'USD',
  'Placeholder note.', '2026-09-03', NULL, '2026-10-08', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
INSERT INTO commission_characters (commission_id, character_id) VALUES (1, 1);

-- A second entry whose "Where it's happening" is plain text, by an artist with
-- a Telegram link, so the read-only page shows the text and Open chat. The
-- spec deletes it before the last test empties the ledger.
INSERT INTO artists (id, name, telegram_url, created_at) VALUES (60, 'Chat Artist', 'https://t.me/e2e_chat_artist', '2026-07-01T00:00:00.000Z');
INSERT INTO commissions (id, artist_id, title, source_url, status, payment, created_at, updated_at)
VALUES (2, 60, 'Chat sketch', 'Telegram DM', 'accepted', 'unpaid', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
