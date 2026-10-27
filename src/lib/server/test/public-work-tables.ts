// The tables artistShownPublicly reads (SONA-236), for a route test whose
// hand-written schema leaves some out. Each is created only if the test didn't
// make its own, with just the columns that check uses.
export const PUBLIC_WORK_TABLES = `
	CREATE TABLE IF NOT EXISTS images (id INTEGER PRIMARY KEY, artist_id INTEGER, published INTEGER NOT NULL DEFAULT 0, parent_image_id INTEGER);
	CREATE TABLE IF NOT EXISTS sticker_packs (id INTEGER PRIMARY KEY, published INTEGER NOT NULL DEFAULT 0, manager_artist_id INTEGER);
	CREATE TABLE IF NOT EXISTS stickers (id INTEGER PRIMARY KEY, pack_id INTEGER, artist_id INTEGER);
	CREATE TABLE IF NOT EXISTS vr_avatars (id INTEGER PRIMARY KEY, published INTEGER NOT NULL DEFAULT 0);
	CREATE TABLE IF NOT EXISTS avatar_credits (avatar_id INTEGER, artist_id INTEGER);
`;
