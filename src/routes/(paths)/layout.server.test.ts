import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { clearSettingsCache } from '$lib/server/settings';
import { makeD1 } from '$lib/server/test/d1';

import { load } from './+layout.server';

// Only the table the layout load touches: settings.
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
	return { sqlite, platform: { env: { DB: makeD1(sqlite) } } as unknown as App.Platform };
}

type LayoutData = { settings: { siteName: string } };

beforeEach(() => clearSettingsCache());

describe('(paths) layout load', () => {
	it("returns the site's settings for the shell's wordmark", async () => {
		const { sqlite, platform } = makeDb();
		sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('siteName', 'Kestrel')").run();
		const data = (await load({ platform } as never)) as LayoutData;
		expect(data.settings.siteName).toBe('Kestrel');
	});
});
