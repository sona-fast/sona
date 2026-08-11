import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { clearSettingsCache } from '$lib/server/settings';
import { clearStickerTabCache } from '$lib/server/stickers';
import { makeD1 } from '$lib/server/test/d1';

import { load } from './+layout.server';

// Only the tables the layout load touches: settings plus the stickers probe.
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY AUTOINCREMENT, published INTEGER NOT NULL DEFAULT 1);
	`);
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

type LayoutData = { stickersEnabled: boolean };

async function loadData(platform: App.Platform): Promise<LayoutData> {
	// The probe cache is per-isolate; clear it so each load sees the current DB
	// (the matrices below re-query after seeding).
	clearStickerTabCache();
	return (await load({ platform } as never)) as LayoutData;
}

beforeEach(() => clearSettingsCache());

describe('(paths) layout load — MobileNav stickers gating', () => {
	it('hides the Stickers tab on an empty fork', async () => {
		const { platform } = makeDb();
		expect((await loadData(platform)).stickersEnabled).toBe(false);
	});

	it('shows the Stickers tab only once a PUBLISHED pack exists (drafts stay hidden)', async () => {
		const { sqlite, platform } = makeDb();
		sqlite.prepare('INSERT INTO sticker_packs (published) VALUES (0)').run();
		expect((await loadData(platform)).stickersEnabled).toBe(false);
		sqlite.prepare('INSERT INTO sticker_packs (published) VALUES (1)').run();
		expect((await loadData(platform)).stickersEnabled).toBe(true);
	});

	it('fails OPEN (tab shown) when the probe hits a D1 failure', async () => {
		// Same posture as the (public) layout: a dead link during a transient D1
		// blip beats hiding a healthy section.
		const failingD1 = {
			prepare: () => {
				throw new Error('D1_ERROR: transient');
			}
		} as unknown as D1Database;
		const platform = { env: { DB: failingD1 } } as unknown as App.Platform;

		expect((await loadData(platform)).stickersEnabled).toBe(true);
	});
});
