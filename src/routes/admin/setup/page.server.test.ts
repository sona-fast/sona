import { describe, it, expect } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { isRedirect } from '@sveltejs/kit';
import * as schema from '$lib/server/db/schema';
import { getRawSetting } from '$lib/server/settings';
import { DEFAULT_THEME_ID } from '$lib/themes';
import { actions } from './+page.server';

import { makeD1 } from '$lib/server/test/d1';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
	CREATE TABLE characters (
		id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_name TEXT, url TEXT,
		twitter_url TEXT, bluesky_url TEXT, telegram_url TEXT, furaffinity_url TEXT,
		deviantart_url TEXT, patreon_url TEXT, instagram_url TEXT, avatar_url TEXT,
		is_owner INTEGER NOT NULL DEFAULT 0, reference_image_id INTEGER, created_at TEXT NOT NULL
	);`);
	const d1 = makeD1(sqlite);
	// The $app/environment stub sets dev=false, so the action walks the
	// production path: SETUP_TOKEN must exist and match the submitted token.
	const platform = { env: { DB: d1, SETUP_TOKEN: 'boot-token' } } as unknown as App.Platform;
	return { db: drizzle(d1, { schema }), platform };
}

const VALID_FIELDS = {
	setupToken: 'boot-token',
	password: 'hunter2hunter2',
	confirmPassword: 'hunter2hunter2',
	siteName: 'Taro Surf'
};

function setupEvent(platform: App.Platform, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries({ ...VALID_FIELDS, ...fields })) body.append(k, v);
	return {
		platform,
		cookies: { set: () => {} },
		request: new Request('https://taro.surf/admin/setup', { method: 'POST', body })
	} as never;
}

describe('setup wizard — unrecognized enum values fail instead of silently defaulting', () => {
	it('rejects an unknown landingLayout and saves nothing', async () => {
		const { db, platform } = makeDb();

		const result = await actions.default(setupEvent(platform, { landingLayout: 'hero' }));

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toMatch(/landing layout/i);
		expect(await getRawSetting(db, 'landingLayout')).toBeNull();
		expect(await getRawSetting(db, 'siteName')).toBeNull();
	});

	it('rejects an unknown themeId and saves nothing', async () => {
		const { db, platform } = makeDb();

		const result = await actions.default(setupEvent(platform, { themeId: 'neon' }));

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toMatch(/theme/i);
		expect(await getRawSetting(db, 'themeId')).toBeNull();
	});

	it('saves the submitted values when they are valid', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(
				setupEvent(platform, {
					themeId: 'terracotta',
					landingLayout: 'threePath',
					adminEmail: 'admin@taro.surf'
				})
			);
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
			expect(e.status).toBe(303);
		}
		expect(await getRawSetting(db, 'themeId')).toBe('terracotta');
		expect(await getRawSetting(db, 'landingLayout')).toBe('threePath');
		// The optional recovery email is persisted when provided.
		expect(await getRawSetting(db, 'adminEmail')).toBe('admin@taro.surf');
	});

	it('rejects an adminEmail that does not look like an email and saves nothing', async () => {
		const { db, platform } = makeDb();

		const result = await actions.default(setupEvent(platform, { adminEmail: 'not-an-email' }));

		expect(result).toMatchObject({ status: 400 });
		expect((result as { data: { error: string } }).data.error).toMatch(/email/i);
		expect(await getRawSetting(db, 'adminEmail')).toBeNull();
		expect(await getRawSetting(db, 'siteName')).toBeNull();
	});

	it('does not write adminEmail when the field is empty', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { adminEmail: '' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'adminEmail')).toBeNull();
	});

	it('takes the defaults when the fields are absent', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, {}));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'themeId')).toBe(DEFAULT_THEME_ID);
	});
});

describe('setup wizard — blank optional fields never clobber CLI-seeded settings (#60)', () => {
	it('a blank primaryCharacter leaves the CLI-seeded value intact', async () => {
		const { db, platform } = makeDb();
		await db.insert(schema.siteSettings).values({ key: 'primaryCharacter', value: 'Sparky' });

		try {
			await actions.default(setupEvent(platform, { primaryCharacter: '' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'primaryCharacter')).toBe('Sparky');
	});

	it('a filled primaryCharacter still saves', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { primaryCharacter: 'Taro' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}
		expect(await getRawSetting(db, 'primaryCharacter')).toBe('Taro');
	});
});

describe('setup wizard — creates the site character as is_owner (excluded from Featured) (#51)', () => {
	it('flags the wizard-created character is_owner=true', async () => {
		const { db, platform } = makeDb();

		try {
			await actions.default(setupEvent(platform, { fursonaName: 'Sparky' }));
			expect.unreachable('setup should redirect on success');
		} catch (e) {
			if (!isRedirect(e)) throw e;
		}

		const row = await db
			.select({ name: schema.characters.name, isOwner: schema.characters.isOwner })
			.from(schema.characters)
			.get();
		expect(row).toEqual({ name: 'Sparky', isOwner: true });
	});
});

describe('setup wizard — missing SETUP_TOKEN error is gh-first (#140 follow-up)', () => {
	it('fails 503 and leads with gh secret set, keeping wrangler as the fallback', async () => {
		const { platform } = makeDb();
		delete (platform as { env: Record<string, unknown> }).env.SETUP_TOKEN;

		const result = await actions.default(setupEvent(platform, {}));

		expect(result).toMatchObject({ status: 503 });
		const error = (result as { data: { error: string } }).data.error;
		const ghAt = error.indexOf('gh secret set SETUP_TOKEN');
		const wranglerAt = error.indexOf('wrangler pages secret put SETUP_TOKEN');
		expect(ghAt).toBeGreaterThanOrEqual(0);
		expect(wranglerAt).toBeGreaterThan(ghAt);
	});
});
