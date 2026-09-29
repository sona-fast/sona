import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { getDb } from '$lib/server/db';

import { firstShowcaseImages } from './vr-showcase';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE avatar_media (
			avatar_id INTEGER NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
			width INTEGER, height INTEGER, position INTEGER NOT NULL DEFAULT 0
		);
	`);
	const ins = sqlite.prepare(
		'INSERT INTO avatar_media (avatar_id, kind, url, width, height, position) VALUES (?, ?, ?, ?, ?, ?)'
	);
	return { db: getDb(makeD1(sqlite) as never), ins };
}

describe('firstShowcaseImages', () => {
	it('returns the lowest-position IMAGE url per requested avatar', async () => {
		const { db, ins } = makeDb();
		ins.run(1, 'video', 'https://cdn.example.com/clip.webm', 1920, 1080, 0);
		ins.run(1, 'image', 'https://cdn.example.com/b.png', 800, 600, 2);
		ins.run(1, 'image', 'https://cdn.example.com/a.png', 1200, 900, 1);
		ins.run(2, 'image', 'https://cdn.example.com/c.png', null, null, 0);
		ins.run(3, 'video', 'https://cdn.example.com/only.webm', null, null, 0);
		// Avatar 4 is not requested and must not leak into the result.
		ins.run(4, 'image', 'https://cdn.example.com/d.png', null, null, 0);

		const result = await firstShowcaseImages(db, [1, 2, 3]);
		expect(result.get(1)).toBe('https://cdn.example.com/a.png');
		expect(result.get(2)).toBe('https://cdn.example.com/c.png');
		expect(result.has(3)).toBe(false);
		expect(result.has(4)).toBe(false);
	});

	it('returns an empty map for no ids without querying', async () => {
		const { db } = makeDb();
		expect((await firstShowcaseImages(db, [])).size).toBe(0);
	});
});
