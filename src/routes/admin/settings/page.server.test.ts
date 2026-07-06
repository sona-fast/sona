import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { siteSettings } from '$lib/server/db/schema';
import { REGISTRY_API_KEY_SETTING } from '$lib/server/registry';
import { getRawSetting, parseLines } from '$lib/server/settings';
import { actions } from './+page.server';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses
// (client.prepare().bind().run()/all()), same approach as sticker-import.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeD1(sqlite: any): D1Database {
	function exec(sql: string, params: unknown[], mode: 'run' | 'all' | 'raw') {
		const stmt = sqlite.prepare(sql);
		if (mode === 'raw') {
			try {
				return stmt.raw(true).all(...params) as unknown[];
			} finally {
				stmt.raw(false);
			}
		}
		if (stmt.reader) return { results: stmt.all(...params), success: true, meta: {} };
		const info = stmt.run(...params);
		return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
	}
	function prepare(sql: string) {
		return {
			bind: (...params: unknown[]) => ({
				run: () => exec(sql, params, 'run'),
				all: () => exec(sql, params, 'all'),
				raw: () => exec(sql, params, 'raw')
			})
		};
	}
	return { prepare } as unknown as D1Database;
}

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(`CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function connectEvent(platform: App.Platform, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	return {
		platform,
		url: new URL('https://taro.surf/admin/settings'),
		request: new Request('https://taro.surf/admin/settings?/connectRegistry', { method: 'POST', body })
	} as never;
}

// Capture the registration request instead of hitting a real registry.
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify({ forkId: 'fork-1', key: 'minted-key' }), { status: 201 })
	);
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

function sentBody(): Record<string, unknown> {
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	expect(String(url)).toContain('/v1/forks');
	return JSON.parse(init.body as string);
}

describe('settings connectRegistry — fork key label', () => {
	it('labels the fork key with the configured site name', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: 'siteName', value: 'Taro Surf' });

		const result = await actions.connectRegistry(connectEvent(platform, { signupToken: 'tok' }));

		expect(result).toMatchObject({ success: true });
		expect(sentBody()).toMatchObject({ signupToken: 'tok', label: 'Taro Surf' });
		// The minted key is persisted so the connection survives without a deploy.
		expect(await getRawSetting(db, REGISTRY_API_KEY_SETTING)).toBe('minted-key');
	});

	it('falls back to the site hostname when no site name is configured', async () => {
		const { platform } = makeDb();

		const result = await actions.connectRegistry(connectEvent(platform, { signupToken: 'tok' }));

		expect(result).toMatchObject({ success: true });
		expect(sentBody()).toMatchObject({ label: 'taro.surf' });
	});
});

function saveSiteEvent(platform: App.Platform, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	return {
		platform,
		request: new Request('https://taro.surf/admin/settings?/saveSite', { method: 'POST', body })
	} as never;
}

describe('settings saveSite — three-path profile fields', () => {
	it('persists the sona profile + contact email and drops malformed swatches', async () => {
		const { db, platform } = makeDb();

		const result = await actions.saveSite(
			saveSiteEvent(platform, {
				siteName: 'Taro Surf',
				splashSubtitle: 'surfing shark',
				contactEmail: 'paws@example.com',
				sonaSpecies: 'Shark',
				sonaBuild: 'Round',
				sonaKeyFeatures: 'Blue fins',
				sonaDos: 'Any style\nShip art is fine',
				sonaDonts: 'No NSFW',
				sonaColors: JSON.stringify([
					{ name: 'Blue', hex: '#3A6EA5' },
					{ name: 'Bad', hex: 'not-a-hex' }
				])
			})
		);

		expect(result).toMatchObject({ success: true });
		expect(await getRawSetting(db, 'contactEmail')).toBe('paws@example.com');
		expect(await getRawSetting(db, 'splashSubtitle')).toBe('surfing shark');
		expect(await getRawSetting(db, 'sonaSpecies')).toBe('Shark');
		// Multipart form encoding normalizes newlines to CRLF (as browsers do);
		// assert through parseLines, which is how /art consumes the value.
		expect(parseLines((await getRawSetting(db, 'sonaDos'))!)).toEqual([
			'Any style',
			'Ship art is fine'
		]);
		// The swatch JSON is re-parsed server-side; entries without a valid hex are dropped.
		expect(JSON.parse((await getRawSetting(db, 'sonaColors'))!)).toEqual([
			{ name: 'Blue', hex: '#3A6EA5' }
		]);
	});
});

describe('settings connectRegistry — reconnect guard', () => {
	it('refuses to mint a second key while one is already stored', async () => {
		const { db, platform } = makeDb();
		await db.insert(siteSettings).values({ key: REGISTRY_API_KEY_SETTING, value: 'existing-key' });

		const result = await actions.connectRegistry(connectEvent(platform, { signupToken: 'tok' }));

		expect(result).toMatchObject({ status: 400, data: { alreadyConnected: true } });
		// No registration request went out, and the stored key is untouched.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await getRawSetting(db, REGISTRY_API_KEY_SETTING)).toBe('existing-key');
	});
});

// saveSite must distinguish a field ABSENT from the POST (skip — the posting
// form doesn't manage that setting) from a field PRESENT but blank (deliberate
// clear). Conditionally-rendered fields (splash subtitle, sona sheet, theme
// pickers) were otherwise silently blanked by saves from forms that don't
// render them (#60 — Sunday's splash subtitle kept reverting to the fallback).
async function seed(db: ReturnType<typeof makeDb>['db'], key: string, value: string) {
	await db.insert(siteSettings).values({ key, value });
}

describe('saveSite — absent fields are skipped, blank fields clear (#60)', () => {
	it('a POST omitting splashSubtitle leaves the stored value intact', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'splashSubtitle', 'shiba supreme');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'sheeb.net' }));

		expect(await getRawSetting(db, 'splashSubtitle')).toBe('shiba supreme');
		expect(await getRawSetting(db, 'siteName')).toBe('sheeb.net');
	});

	it('a POST with splashSubtitle present-but-blank clears it deliberately', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'splashSubtitle', 'shiba supreme');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'sheeb.net', splashSubtitle: '' }));

		expect(await getRawSetting(db, 'splashSubtitle')).toBe('');
	});

	it('a POST omitting themeId/landingLayout does not reset them to defaults', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'themeId', 'terracotta');
		await seed(db, 'landingLayout', 'threePath');

		await actions.saveSite(saveSiteEvent(platform, { ownerName: 'Sunday' }));

		expect(await getRawSetting(db, 'themeId')).toBe('terracotta');
		expect(await getRawSetting(db, 'landingLayout')).toBe('threePath');
	});

	it('a POST omitting bluesky leaves blueskyUrl and the derived avatar alone', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'blueskyUrl', 'https://bsky.app/profile/sunday.bsky.social');
		await seed(db, 'adminAvatarUrl', 'https://cdn.bsky.app/img/avatar/plain/x');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'sheeb.net' }));

		expect(await getRawSetting(db, 'blueskyUrl')).toBe('https://bsky.app/profile/sunday.bsky.social');
		expect(await getRawSetting(db, 'adminAvatarUrl')).toBe('https://cdn.bsky.app/img/avatar/plain/x');
	});

	it('a POST omitting sonaColors keeps the stored swatches', async () => {
		const { db, platform } = makeDb();
		await seed(db, 'sonaColors', '[{"name":"fur","hex":"#DD5131"}]');

		await actions.saveSite(saveSiteEvent(platform, { siteName: 'sheeb.net' }));

		expect(await getRawSetting(db, 'sonaColors')).toBe('[{"name":"fur","hex":"#DD5131"}]');
	});
});
