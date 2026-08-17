import { describe, it, expect, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { R2Bucket } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import type { SiteSettings } from '$lib/server/settings';
import { makeD1 } from '$lib/server/test/d1';
import { staticWebp } from './test/raster-fixtures';
import { importFursuitPhotos, fursuitPhotosExist, clearFursuitPhotosCache } from './fursuit-import';

const DDL = `
CREATE TABLE fursuit_photos (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	furtrack_post_id INTEGER NOT NULL UNIQUE,
	character TEXT NOT NULL,
	description TEXT,
	image_url TEXT NOT NULL,
	width INTEGER,
	height INTEGER,
	photographer TEXT NOT NULL,
	photographer_url TEXT,
	event TEXT,
	license TEXT NOT NULL,
	permission_source TEXT,
	furtrack_url TEXT NOT NULL,
	taken_at TEXT,
	created_at TEXT NOT NULL
);
`;

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(DDL);
	return { db: drizzle(makeD1(sqlite), { schema }), sqlite };
}

type ImportOpts = Parameters<typeof importFursuitPhotos>[0];

// FURTRACK_MODE=mock serves the bundled sample photos (no FurTrack calls); the
// fake R2 bucket keeps storage.put local. 1918883 is a displayable (CC-BY)
// mock photo.
const fakeBucket = { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) };
const testEnv = {
	FURTRACK_MODE: 'mock',
	IMAGES: fakeBucket as unknown as R2Bucket
} as unknown as ImportOpts['env'];
const testSettings = { primaryCharacter: '', storageProvider: 'r2' } as unknown as SiteSettings;
// The photo "download" — a real static WebP so the sniff check passes offline.
const fetchFn = vi.fn(
	async () =>
		new Response(staticWebp().buffer as ArrayBuffer, { headers: { 'content-type': 'image/webp' } })
) as unknown as typeof fetch;

describe('importFursuitPhotos', () => {
	it('clears the fursuit probe cache so the tab can flip in this isolate', async () => {
		const { db } = makeDb();
		// Prime the cached probe with "no photos stored".
		clearFursuitPhotosCache();
		expect(await fursuitPhotosExist(db)).toBe(false);

		const result = await importFursuitPhotos({
			env: testEnv,
			settings: testSettings,
			db,
			fetchFn,
			character: 'Sparky',
			postIds: [1918883]
		});
		expect(result.imported).toBe(1);

		// No manual clear here — the import path itself must have invalidated the
		// cache, or this still reads the primed `false` for up to the TTL.
		expect(await fursuitPhotosExist(db)).toBe(true);
	});

	it('fails a photo whose remote body exceeds the 10 MiB import cap', async () => {
		const { db } = makeDb();
		// Remote import bodies keep the old 10 MiB bound, decoupled from the raised
		// 64 MiB local upload cap. A valid WebP head so the content-type gate isn't
		// what trips — the byte cap is.
		const big = new Uint8Array(10 * 1024 * 1024 + 1);
		big.set(staticWebp());
		const bigFetch = vi.fn(
			async () => new Response(big.buffer as ArrayBuffer, { headers: { 'content-type': 'image/webp' } })
		) as unknown as typeof fetch;

		const result = await importFursuitPhotos({
			env: testEnv,
			settings: testSettings,
			db,
			fetchFn: bigFetch,
			character: 'Sparky',
			postIds: [1918883]
		});

		expect(result.imported).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.items[0]).toMatchObject({ postId: 1918883, status: 'failed' });
		expect(result.items[0].error).toMatch(/buffer cap/);
	});
});
