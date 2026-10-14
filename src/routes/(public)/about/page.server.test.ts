import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { clearSettingsCache } from '$lib/server/settings';
import { makeD1 } from '$lib/server/test/d1';
import { load } from './+page.server';

beforeEach(() => clearSettingsCache());

// Every migration, applied in order, so the count runs against the shipped
// schema rather than hand-written tables.
function migrated() {
	const sqlite = new Database(':memory:');
	const dir = new URL('../../../../drizzle/', import.meta.url);
	for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
		for (const stmt of readFileSync(new URL(name, dir), 'utf8').split('--> statement-breakpoint')) sqlite.exec(stmt);
	}
	return sqlite;
}

// SONA-236: an artist added only for a private commission entry must not raise
// the public artist count, so /about counts artists with public work only.
describe('/about artist count', () => {
	it('counts only artists with public work, never a ledger-only artist', async () => {
		const sqlite = migrated();
		const artist = sqlite.prepare("INSERT INTO artists (id, name, created_at) VALUES (?, ?, '2026-10-01')");
		const names = ['Published piece', 'Draft only', 'Sticker in published pack', 'Sticker in draft pack',
			'Manages published pack', 'Published avatar credit', 'Draft avatar credit', 'Ledger only'];
		names.forEach((n, i) => artist.run(i + 1, n));
		sqlite.prepare("INSERT INTO characters (id, name, created_at) VALUES (1, 'Kit', '2026-10-01')").run();

		const image = sqlite.prepare(
			"INSERT INTO images (slug, title, image_url, artist_id, published, created_at) VALUES (?, 'Piece', '/a.png', ?, ?, '2026-10-01')"
		);
		image.run('published', 1, 1);
		image.run('draft', 2, 0);

		const pack = sqlite.prepare(
			"INSERT INTO sticker_packs (id, name, slug, character_id, manager_artist_id, source, published, created_at) VALUES (?, 'Pack', ?, 1, ?, 'self-hosted', ?, '2026-10-01')"
		);
		pack.run(1, 'published-pack', 5, 1);
		pack.run(2, 'draft-pack', null, 0);
		const sticker = sqlite.prepare("INSERT INTO stickers (pack_id, artist_id, image_url, created_at) VALUES (?, ?, '/s.webp', '2026-10-01')");
		sticker.run(1, 3);
		sticker.run(2, 4);

		const avatar = sqlite.prepare(
			"INSERT INTO vr_avatars (id, slug, name, character_id, published, created_at) VALUES (?, ?, 'Kit', 1, ?, '2026-10-01')"
		);
		avatar.run(1, 'published-avatar', 1);
		avatar.run(2, 'draft-avatar', 0);
		const credit = sqlite.prepare("INSERT INTO avatar_credits (avatar_id, artist_id, role) VALUES (?, ?, 'modeler')");
		credit.run(1, 6);
		credit.run(2, 7);

		sqlite
			.prepare(
				"INSERT INTO commissions (artist_id, title, notes, created_at, updated_at) VALUES (8, 'Secret ref sheet', 'Private note', '2026-10-01', '2026-10-01')"
			)
			.run();

		const data = (await load({ platform: { env: { DB: makeD1(sqlite) } } } as never)) as {
			stats: { artists: number };
		};

		expect(data.stats.artists).toBe(4);
		const serialized = JSON.stringify(data);
		expect(serialized).not.toContain('Secret ref sheet');
		expect(serialized).not.toContain('Private note');
	});
});
