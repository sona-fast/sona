-- One commission ledger entry for the gated ledger spec (SONA-236), layered on
-- seed.sql: artist 1 (Test Artist) and character 1 (Taro) come from there. Two
-- dates, so the read-only entry page shows both as plain dates. Private fields
-- are placeholders, never real chat links or notes.
INSERT INTO commissions (id, artist_id, title, kind, source_url, status, payment, price_minor, currency, notes,
  requested_on, accepted_on, delivered_on, created_at, updated_at)
VALUES (1, 1, 'Headshot icon', 'Icon', 'https://example.com/opening', 'delivered', 'paid', 4500, 'USD',
  'Placeholder note.', '2026-09-03', NULL, '2026-10-08', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
INSERT INTO commission_characters (commission_id, character_id) VALUES (1, 1);
