import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { load } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

// No clearSettingsCache() here: the share gate reads site_settings directly
// (bypassing the getSettings cache) so a D1 failure surfaces instead of
// decaying into a false 404.

describe('share load — content-presence gate (#42)', () => {
	it('404s when neither contact email nor Telegram is configured', async () => {
		const { platform } = makeDb();
		await expect(load({ platform } as never)).rejects.toMatchObject({ status: 404 });
	});

	it('loads with only a contact email', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'contactEmail', value: 'hi@example.ink' });
		await expect(load({ platform } as never)).resolves.toEqual({});
	});

	it('loads with only a Telegram URL', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'telegramUrl', value: 'https://t.me/example' });
		await expect(load({ platform } as never)).resolves.toEqual({});
	});

	it('loads with both configured', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values([
			{ key: 'contactEmail', value: 'hi@example.ink' },
			{ key: 'telegramUrl', value: 'https://t.me/example' }
		]);
		await expect(load({ platform } as never)).resolves.toEqual({});
	});

	it('rejects with the query error (not a 404) when D1 fails transiently', async () => {
		const failingD1 = {
			prepare: () => {
				throw new Error('D1_ERROR: transient');
			}
		} as unknown as D1Database;
		const platform = { env: { DB: failingD1 } } as unknown as App.Platform;
		// The raw D1 error must surface (→ 500 "retry" semantics), not the
		// gate's 404 — a configured fork must not look deleted during a blip.
		await expect(load({ platform } as never)).rejects.toThrow('D1_ERROR: transient');
	});
});
