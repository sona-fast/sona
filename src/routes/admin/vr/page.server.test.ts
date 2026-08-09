import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { EARLY_ACCESS } from '$lib/early-access';

import { load } from './+page.server';

const NOW = '2026-01-01T00:00:00.000Z';

// The gating tests below drive the gate through the registry (same mutation
// pattern as early-access.test.ts) so they never depend on the wall clock.
const SHIPPED = { ...EARLY_ACCESS };
const FUTURE_GA = '2999-01-01';
const PAST_GA = '2000-01-01';
function restoreRegistry() {
	for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
	Object.assign(EARLY_ACCESS, SHIPPED);
}
beforeEach(restoreRegistry);
afterEach(restoreRegistry);

// Only the tables the /admin/vr list load touches, columns limited to what its
// queries reference (same shape as the public vr page.server.test.ts).
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE vr_avatars (
			id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
			character_id INTEGER NOT NULL, model_url TEXT, model_format TEXT,
			model_size_bytes INTEGER, poster_image_id INTEGER, external_url TEXT,
			license TEXT, permission_source TEXT, downloadable INTEGER NOT NULL DEFAULT 0,
			nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
			description TEXT, created_at TEXT NOT NULL
		);
		CREATE TABLE avatar_platforms (avatar_id INTEGER NOT NULL, platform TEXT NOT NULL);
		CREATE TABLE characters (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL
		);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, image_url TEXT NOT NULL, thumbnail_url TEXT,
			file_size INTEGER
		);
	`);
	sqlite.prepare('INSERT INTO characters (id, name) VALUES (1, ?)').run('Taro');
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function addAvatar(
	sqlite: ReturnType<typeof makeDb>['sqlite'],
	opts: {
		slug: string;
		modelUrl?: string | null;
		modelFormat?: string | null;
		modelSizeBytes?: number | null;
		published?: number;
		nsfw?: number;
	}
) {
	return sqlite
		.prepare(
			`INSERT INTO vr_avatars (slug, name, character_id, model_url, model_format, model_size_bytes, published, nsfw, created_at)
			 VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			opts.slug,
			opts.slug,
			opts.modelUrl ?? null,
			opts.modelFormat ?? null,
			opts.modelSizeBytes ?? null,
			opts.published ?? 1,
			opts.nsfw ?? 0,
			NOW
		).lastInsertRowid as number;
}

type ListData = {
	publishingEnabled: boolean;
	gaDateDisplay: string | null;
	avatars: Array<{
		slug: string;
		published: boolean;
		platformCount: number;
		hasModel: boolean;
	}>;
	storage: { usedBytes: number; limitBytes: number };
};

async function loadData(platform: App.Platform): Promise<ListData> {
	return (await load({ platform } as never)) as ListData;
}

describe('/admin/vr list load', () => {
	it('lists ALL avatars (drafts included — reading is never gated) with platform counts', async () => {
		const { sqlite, platform } = makeDb();
		const live = addAvatar(sqlite, { slug: 'live' });
		addAvatar(sqlite, { slug: 'draft', published: 0 });
		sqlite.prepare('INSERT INTO avatar_platforms (avatar_id, platform) VALUES (?, ?)').run(live, 'vrchat');
		sqlite.prepare('INSERT INTO avatar_platforms (avatar_id, platform) VALUES (?, ?)').run(live, 'resonite');

		const data = await loadData(platform);
		expect(data.avatars.map((a) => a.slug).sort()).toEqual(['draft', 'live']);
		const bySlug = Object.fromEntries(data.avatars.map((a) => [a.slug, a]));
		expect(bySlug.live.platformCount).toBe(2);
		expect(bySlug.draft.platformCount).toBe(0);
	});

	it('sums the storage line from tracked image bytes PLUS model bytes (settings-gauge mechanism)', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO images (image_url, thumbnail_url, file_size) VALUES (?, NULL, ?)')
			.run('/img/a.png', 1000);
		sqlite
			.prepare('INSERT INTO images (image_url, thumbnail_url, file_size) VALUES (?, NULL, ?)')
			.run('/img/b.png', 2000);
		addAvatar(sqlite, { slug: 'hosted', modelUrl: '/img/vr-models/a.vrm', modelFormat: 'vrm', modelSizeBytes: 500 });
		addAvatar(sqlite, { slug: 'external' }); // no model — contributes nothing

		const data = await loadData(platform);
		expect(data.storage.usedBytes).toBe(3500);
		expect(data.storage.limitBytes).toBe(10 * 1024 * 1024 * 1024);
	});

	it('is gated pre-GA without a key, and reports the GA date for the gate copy', async () => {
		EARLY_ACCESS['vr-avatars'] = FUTURE_GA;
		const { platform } = makeDb();
		const data = await loadData(platform);
		expect(data.publishingEnabled).toBe(false);
		expect(data.gaDateDisplay).toBe('2999.01.01');
	});

	it('a malformed stored supporter key does not open the gate', async () => {
		EARLY_ACCESS['vr-avatars'] = FUTURE_GA;
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)')
			.run('supporterKey', 'not-a-real-key');
		const data = await loadData(platform);
		expect(data.publishingEnabled).toBe(false);
	});

	it('is ungated once the GA date has passed', async () => {
		EARLY_ACCESS['vr-avatars'] = PAST_GA;
		const { platform } = makeDb();
		const data = await loadData(platform);
		expect(data.publishingEnabled).toBe(true);
	});
});
