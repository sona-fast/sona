import { describe, it, expect, beforeEach } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { clearSettingsCache } from '$lib/server/settings';
import { makeD1 } from '$lib/server/test/d1';
import { APP_NAME } from '$lib/config';

import { load } from './+layout.server';

// The ROOT layout load. Its payload drives the default <title> and the RSS
// autodiscovery <link> in the head — the one place a fork that turned the feed
// off would otherwise keep advertising it.
function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec('CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
	const d1 = makeD1(sqlite);
	return { sqlite, platform: { env: { DB: d1 } } as unknown as App.Platform };
}

type LayoutData = { siteName: string; rssFeedEnabled: boolean };

const loadData = async (platform?: App.Platform): Promise<LayoutData> =>
	(await load({ platform } as never)) as LayoutData;

beforeEach(() => clearSettingsCache());

describe('root layout load — RSS autodiscovery flag', () => {
	it('advertises the feed when nothing is stored (absent means on)', async () => {
		const { platform } = makeDb();
		expect((await loadData(platform)).rssFeedEnabled).toBe(true);
	});

	it('stops advertising it once the owner stores false', async () => {
		// The regression this guards: hardcoding true here would keep the
		// <link rel="alternate"> in the head of every fork that turned the feed
		// off, pointing readers at a route that 404s.
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare("INSERT INTO site_settings (key, value) VALUES ('rssFeedEnabled', 'false')")
			.run();

		expect((await loadData(platform)).rssFeedEnabled).toBe(false);
	});

	it('passes the configured site name through', async () => {
		const { sqlite, platform } = makeDb();
		sqlite.prepare("INSERT INTO site_settings (key, value) VALUES ('siteName', ?)").run('Taro');

		expect((await loadData(platform)).siteName).toBe('Taro');
	});

	it('fails OPEN with no DB binding at all', async () => {
		// Same posture the footer link takes: a stray <link> during a read blip
		// costs a reader one 404, while /feed.xml itself gates on a raw,
		// fail-closed read.
		expect(await loadData(undefined)).toEqual({ siteName: APP_NAME, rssFeedEnabled: true });
	});

	it('fails OPEN when the settings read cannot see its table', async () => {
		// The mid-deploy fork case. Note the path: getSettings catches the D1 error
		// itself and returns DEFAULTS, so this never reaches the load's own catch —
		// but the observable payload is the same fail-open one either way.
		const { sqlite, platform } = makeDb();
		sqlite.exec('DROP TABLE site_settings');

		expect(await loadData(platform)).toEqual({ siteName: APP_NAME, rssFeedEnabled: true });
	});
});
