import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { clearSettingsCache } from '$lib/server/settings';
import { makeD1 } from '$lib/server/test/d1';

import { load } from './+layout.server';

// Only the tables the layout load touches: settings plus the two nav probes.
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
		CREATE TABLE collections (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL,
			cover_image_url TEXT, created_at TEXT NOT NULL DEFAULT ''
		);
	`);
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

type LayoutData = { stickersEnabled: boolean; collectionsEnabled: boolean; host: string };

async function loadData(platform: App.Platform): Promise<LayoutData> {
	return (await load({ platform, url: new URL('http://example.ink/gallery') } as never)) as LayoutData;
}

beforeEach(() => clearSettingsCache());

describe('(public) layout load — nav content gating', () => {
	it('hides both gated links on an empty fork', async () => {
		const { platform } = makeDb();
		const data = await loadData(platform);
		expect(data.stickersEnabled).toBe(false);
		expect(data.collectionsEnabled).toBe(false);
	});

	it('shows the Stickers link only once a PUBLISHED pack exists (drafts stay hidden)', async () => {
		const { sqlite, platform } = makeDb();
		sqlite.prepare('INSERT INTO sticker_packs (published) VALUES (0)').run();
		expect((await loadData(platform)).stickersEnabled).toBe(false);
		sqlite.prepare('INSERT INTO sticker_packs (published) VALUES (1)').run();
		expect((await loadData(platform)).stickersEnabled).toBe(true);
	});

	it('shows the Collections link on bare row existence — mirroring the /collections page, which lists a collection even with zero published images', async () => {
		const { sqlite, platform } = makeDb();
		sqlite.prepare("INSERT INTO collections (name, slug) VALUES ('Empty', 'empty')").run();
		expect((await loadData(platform)).collectionsEnabled).toBe(true);
	});

	it('fails OPEN (links shown) when the probes hit a D1 failure', async () => {
		// Same posture as the settings read this load already caps: a dead link
		// during a transient D1 blip beats hiding sections of a healthy site.
		const failingD1 = {
			prepare: () => {
				throw new Error('D1_ERROR: transient');
			}
		} as unknown as D1Database;
		const platform = { env: { DB: failingD1 } } as unknown as App.Platform;

		const data = await loadData(platform);
		expect(data.stickersEnabled).toBe(true);
		expect(data.collectionsEnabled).toBe(true);
	});
});
