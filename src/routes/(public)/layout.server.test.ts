import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { clearSettingsCache } from '$lib/server/settings';
import { clearStickerTabCache } from '$lib/server/stickers';
import { clearCollectionsNavCache } from '$lib/server/collections';
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
	// The probe caches are per-isolate; clear them so each load sees the current
	// DB (the matrices below re-query after seeding). The caching behavior
	// itself is pinned by the dedicated test at the bottom.
	clearStickerTabCache();
	clearCollectionsNavCache();
	return (await load({ platform, url: new URL('http://example.ink/gallery') } as never)) as LayoutData;
}

beforeEach(() => clearSettingsCache());

describe('(public) layout load — settings payload', () => {
	// The /ai override text must NOT ride the layout payload: this load runs on
	// every public page, and a fork that turned the page off would otherwise keep
	// shipping its retired copy to every visitor (/ai's own load returns it).
	it('strips aiPageText while keeping the toggle the footer needs', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare("INSERT INTO site_settings (key, value) VALUES ('aiPageText', ?)")
			.run('Owner override copy.');

		const data = (await loadData(platform)) as unknown as {
			settings: Record<string, unknown>;
		};

		expect(data.settings).not.toHaveProperty('aiPageText');
		expect(data.settings.aiPageEnabled).toBe(true);
		expect(JSON.stringify(data)).not.toContain('Owner override copy.');
	});

	// The strip lives in toPublicSettings so no public load can forget it — the
	// first version stripped only here, and the homepage, /about and the whole
	// (paths) group kept shipping the override to every visitor.
	it('is applied by toPublicSettings, which every public load returns through', async () => {
		const { toPublicSettings } = await import('$lib/server/settings');
		const full = { aiPageEnabled: false, aiPageText: 'Retired copy.', siteName: 'X' };
		const pub = toPublicSettings(full as never) as Record<string, unknown>;
		expect(pub).not.toHaveProperty('aiPageText');
		expect(pub.aiPageEnabled).toBe(false);

		// Pin the CALL, not the identifier: a leftover import satisfies a bare
		// substring scan, so reverting `settings: toPublicSettings(settings)` to
		// `settings` would leave this green while the override leaked again.
		const sources = ['(public)/+layout.server.ts', '(public)/+page.server.ts', '(public)/about/+page.server.ts', '(paths)/+layout.server.ts'];
		const { readFileSync } = await import('node:fs');
		for (const rel of sources) {
			const src = readFileSync(new URL(`../../routes/${rel}`, import.meta.url), 'utf8');
			expect(src, `${rel} must RETURN settings through toPublicSettings`).toMatch(
				/settings: toPublicSettings\(|const publicSettings = toPublicSettings\(/
			);
		}
	});
});

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

	it('caches the probe results per-isolate (stale until cleared, like the settings cache)', async () => {
		// These probes run on EVERY public request — a repeat load must not
		// re-query D1. Prove it via staleness: seed content AFTER a load and the
		// flags stay false until the caches are cleared.
		const { sqlite, platform } = makeDb();
		expect(await loadData(platform)).toMatchObject({
			stickersEnabled: false,
			collectionsEnabled: false
		});

		sqlite.prepare('INSERT INTO sticker_packs (published) VALUES (1)').run();
		sqlite.prepare("INSERT INTO collections (name, slug) VALUES ('C', 'c')").run();
		const stale = (await load({
			platform,
			url: new URL('http://example.ink/gallery')
		} as never)) as LayoutData;
		expect(stale.stickersEnabled).toBe(false);
		expect(stale.collectionsEnabled).toBe(false);

		expect(await loadData(platform)).toMatchObject({
			stickersEnabled: true,
			collectionsEnabled: true
		});
	});
});
