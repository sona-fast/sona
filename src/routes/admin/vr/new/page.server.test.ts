import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { isRedirect } from '@sveltejs/kit';
import { makeD1 } from '$lib/server/test/d1';
import { clearSettingsCache, clearSupporterKeyStatusCache } from '$lib/server/settings';
import { EARLY_ACCESS } from '$lib/early-access';

import { actions } from './+page.server';

// A real supporter key can't be minted in tests (the issuer key is baked in),
// so verifySupporterKey is faked: the literal token 'VALID' verifies, anything
// else is malformed. The gate logic on top of it stays real.
vi.mock('$lib/server/supporter-key', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/supporter-key')>();
	return {
		...original,
		verifySupporterKey: vi.fn(async (token: string) =>
			token === 'VALID'
				? { valid: true, login: 'e2e', tier: 1, expiresAt: new Date('2999-01-01') }
				: { valid: false, reason: 'malformed' }
		)
	};
});

// Registry-driven gate control (same mutation pattern as early-access.test.ts)
// so no test depends on the wall clock.
const SHIPPED = { ...EARLY_ACCESS };
const FUTURE_GA = '2999-01-01';
const PAST_GA = '2000-01-01';
function restoreRegistry() {
	for (const k of Object.keys(EARLY_ACCESS)) delete EARLY_ACCESS[k];
	Object.assign(EARLY_ACCESS, SHIPPED);
}
beforeEach(() => {
	restoreRegistry();
	// getSettings caches per isolate and every test builds a fresh DB.
	clearSettingsCache();
	// The gate memoizes the verified supporter key per isolate; every test builds
	// a fresh DB, so the previous test's key would otherwise answer for this one.
	clearSupporterKeyStatusCache();
});
afterEach(restoreRegistry);

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
		CREATE TABLE avatar_credits (
			avatar_id INTEGER NOT NULL, artist_id INTEGER NOT NULL, role TEXT NOT NULL,
			role_label TEXT, position INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE avatar_platforms (avatar_id INTEGER NOT NULL, platform TEXT NOT NULL);
		CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
		CREATE TABLE artists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, image_url TEXT NOT NULL, thumbnail_url TEXT,
			title TEXT, file_size INTEGER, nsfw INTEGER NOT NULL DEFAULT 0, created_at TEXT
		);
	`);
	sqlite.exec(`
		CREATE TABLE avatar_media (
			avatar_id INTEGER NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
			width INTEGER, height INTEGER, position INTEGER NOT NULL DEFAULT 0
		);
	`);
	sqlite.prepare('INSERT INTO characters (id, name) VALUES (1, ?)').run('Taro');
	sqlite.prepare('INSERT INTO artists (id, name) VALUES (1, ?)').run('Test Artist');
	const d1 = makeD1(sqlite);
	// IMAGES makes the R2 provider constructible so validateAvatarMedia can
	// recognise self-hosted /img/… media URLs as owned.
	return { sqlite, platform: { env: { DB: d1, IMAGES: {} } } as unknown as App.Platform };
}

function setKey(sqlite: ReturnType<typeof makeDb>['sqlite'], token: string) {
	sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run('supporterKey', token);
}

function baseForm(overrides: Record<string, string | string[]> = {}): FormData {
	const form = new FormData();
	form.set('name', 'Taro VRChat');
	form.set('slug', 'taro-vrchat');
	form.set('characterId', '1');
	for (const [k, v] of Object.entries(overrides)) {
		if (Array.isArray(v)) for (const item of v) form.append(k, item);
		else form.set(k, v);
	}
	return form;
}

async function create(platform: App.Platform, form: FormData) {
	const request = new Request('http://localhost/admin/vr/new', { method: 'POST', body: form });
	const url = new URL('http://localhost/admin/vr/new');
	return actions.default({ request, platform, url } as never);
}

/** Runs the action and reports the outcome: a redirect (created) or a fail status. */
async function outcomeOf(platform: App.Platform, form: FormData): Promise<number | 'created'> {
	try {
		const result = await create(platform, form);
		return result && 'status' in (result as object) ? (result as { status: number }).status : 'created';
	} catch (e) {
		if (isRedirect(e)) return 'created';
		throw e;
	}
}

describe('create action gate matrix (pre-GA)', () => {
	it.each([
		['absent', null, 403],
		['invalid', 'garbage-token', 403],
		['valid', 'VALID', 'created']
	] as const)('key %s → %s', async (_label, token, expected) => {
		EARLY_ACCESS['vr-avatars'] = FUTURE_GA;
		const { sqlite, platform } = makeDb();
		if (token) setKey(sqlite, token);
		expect(await outcomeOf(platform, baseForm())).toBe(expected);
		const count = sqlite.prepare('SELECT COUNT(*) AS n FROM vr_avatars').get() as { n: number };
		expect(count.n).toBe(expected === 'created' ? 1 : 0);
	});
});

describe('create action once GA is reached', () => {
	it('creates without any key (ungated)', async () => {
		EARLY_ACCESS['vr-avatars'] = PAST_GA;
		const { sqlite, platform } = makeDb();
		expect(await outcomeOf(platform, baseForm())).toBe('created');
		const row = sqlite.prepare('SELECT slug, name FROM vr_avatars').get() as {
			slug: string;
			name: string;
		};
		expect(row).toEqual({ slug: 'taro-vrchat', name: 'Taro VRChat' });
	});
});

describe('create action validation', () => {
	beforeEach(() => {
		EARLY_ACCESS['vr-avatars'] = PAST_GA; // ungated — validation is what's under test
	});

	it("requires roleLabel for role='other' credits", async () => {
		const { sqlite, platform } = makeDb();
		const form = baseForm({
			'credit[0][artistId]': '1',
			'credit[0][role]': 'other',
			'credit[0][roleLabel]': ''
		});
		expect(await outcomeOf(platform, form)).toBe(400);
		expect((sqlite.prepare('SELECT COUNT(*) AS n FROM vr_avatars').get() as { n: number }).n).toBe(0);
	});

	it("stores the roleLabel for role='other' when provided, with positions from row order", async () => {
		const { sqlite, platform } = makeDb();
		const form = baseForm({
			'credit[0][artistId]': '1',
			'credit[0][role]': 'base',
			'credit[1][artistId]': '1',
			'credit[1][role]': 'other',
			'credit[1][roleLabel]': 'Blendshapes'
		});
		expect(await outcomeOf(platform, form)).toBe('created');
		const credits = sqlite
			.prepare('SELECT role, role_label, position FROM avatar_credits ORDER BY position')
			.all() as Array<{ role: string; role_label: string | null; position: number }>;
		expect(credits).toEqual([
			{ role: 'base', role_label: null, position: 0 },
			{ role: 'other', role_label: 'Blendshapes', position: 1 }
		]);
	});

	it('rejects a duplicate slug', async () => {
		const { sqlite, platform } = makeDb();
		sqlite
			.prepare(
				`INSERT INTO vr_avatars (slug, name, character_id, created_at) VALUES ('taro-vrchat', 'Existing', 1, '2026-01-01')`
			)
			.run();
		expect(await outcomeOf(platform, baseForm())).toBe(400);
	});

	it('stores platform selections deduped to the known set', async () => {
		const { sqlite, platform } = makeDb();
		const form = baseForm({ platforms: ['vrchat', 'vrchat', 'resonite', 'not-a-platform'] });
		expect(await outcomeOf(platform, form)).toBe('created');
		const rows = sqlite.prepare('SELECT platform FROM avatar_platforms ORDER BY platform').all() as Array<{
			platform: string;
		}>;
		expect(rows.map((r) => r.platform)).toEqual(['resonite', 'vrchat']);
	});

	it('rejects downloadable=true without a recorded permission source (C1)', async () => {
		const { sqlite, platform } = makeDb();
		expect(await outcomeOf(platform, baseForm({ downloadable: '1' }))).toBe(400);
		expect((sqlite.prepare('SELECT COUNT(*) AS n FROM vr_avatars').get() as { n: number }).n).toBe(0);
	});

	it('accepts downloadable=true once a permission source is recorded', async () => {
		const { platform } = makeDb();
		const form = baseForm({ downloadable: '1', permissionSource: 'Telegram DM 2026-08-01' });
		expect(await outcomeOf(platform, form)).toBe('created');
	});

	it('400s when the referenced character does not exist', async () => {
		const { platform } = makeDb();
		expect(await outcomeOf(platform, baseForm({ characterId: '999' }))).toBe(400);
	});

	it('400s when the referenced poster image does not exist', async () => {
		const { platform } = makeDb();
		expect(await outcomeOf(platform, baseForm({ posterImageId: '999' }))).toBe(400);
	});

	it('persists showcase media rows in display order with kind and dimensions', async () => {
		const { sqlite, platform } = makeDb();
		const form = baseForm({
			'media[0][url]': '/img/vr-media/shot.png',
			'media[0][kind]': 'image',
			'media[0][width]': '1920',
			'media[0][height]': '1080',
			'media[1][url]': '/img/vr-media/clip.webm',
			'media[1][kind]': 'video',
			'media[1][width]': '',
			'media[1][height]': ''
		});
		expect(await outcomeOf(platform, form)).toBe('created');
		const rows = sqlite
			.prepare('SELECT kind, url, width, height, position FROM avatar_media ORDER BY position')
			.all() as Array<{ kind: string; url: string; width: number | null; height: number | null; position: number }>;
		expect(rows).toEqual([
			{ kind: 'image', url: '/img/vr-media/shot.png', width: 1920, height: 1080, position: 0 },
			{ kind: 'video', url: '/img/vr-media/clip.webm', width: null, height: null, position: 1 }
		]);
	});

	it('rejects hot-linked (non-self-hosted) showcase media URLs', async () => {
		const { sqlite, platform } = makeDb();
		const form = baseForm({
			'media[0][url]': 'https://elsewhere.example/steal.png',
			'media[0][kind]': 'image'
		});
		expect(await outcomeOf(platform, form)).toBe(400);
		expect((sqlite.prepare('SELECT COUNT(*) AS n FROM vr_avatars').get() as { n: number }).n).toBe(0);
	});

	it('accepts media stored under a FORMER r2PublicUrl via the pathname-key branch (R2-D2)', async () => {
		// Changing the CDN base must not lock every save of an avatar with media:
		// the URL was absolutized at upload time, but its path still spells our
		// vr-media/ partition (the modelKeyFromUrl rule serving/disposal use).
		const { platform } = makeDb();
		const form = baseForm({
			'media[0][url]': 'https://old-cdn.example/vr-media/shot.png',
			'media[0][kind]': 'image'
		});
		expect(await outcomeOf(platform, form)).toBe('created');
	});

	it('rejects a foreign modelUrl submitted through the hidden field (SSRF, R2-S1)', async () => {
		// modelUrl is client-editable; on a provider-fetch fork resolveModelBytes
		// would relay whatever host it names to anonymous visitors.
		const { sqlite, platform } = makeDb();
		const form = baseForm({
			modelUrl: 'https://attacker.example/exfil.vrm',
			modelFormat: 'vrm',
			modelSizeBytes: '1234'
		});
		expect(await outcomeOf(platform, form)).toBe(400);
		expect((sqlite.prepare('SELECT COUNT(*) AS n FROM vr_avatars').get() as { n: number }).n).toBe(0);
	});

	it('accepts our own model URLs: /img-relative and former-base vr-models/ paths', async () => {
		const { platform } = makeDb();
		expect(
			await outcomeOf(
				platform,
				baseForm({ modelUrl: '/img/vr-models/a.vrm', modelFormat: 'vrm', modelSizeBytes: '10' })
			)
		).toBe('created');
		const { platform: p2 } = makeDb();
		expect(
			await outcomeOf(
				p2,
				baseForm({
					slug: 'taro-vrchat-2',
					modelUrl: 'https://old-cdn.example/vr-models/a.vrm',
					modelFormat: 'vrm',
					modelSizeBytes: '10'
				})
			)
		).toBe('created');
	});
});

describe('create action E2E_VR_GATE override (test-only bypass)', () => {
	it("is inert outside dev builds — even the exact value 'open' stays closed", async () => {
		// The bypass is guarded on $app/environment's `dev`, which the vitest
		// stub pins to false (vitest-stubs/app-environment.ts) — exactly what a
		// production build compiles to. A dashboard var set on a production
		// deployment must NOT open the pre-GA gate; the dev-build behavior
		// (bypass honored) is covered by the e2e suite, which runs `vite dev`
		// with E2E_VR_GATE=open in wrangler.e2e.toml.
		EARLY_ACCESS['vr-avatars'] = FUTURE_GA;
		const open = makeDb();
		(open.platform as unknown as { env: Record<string, unknown> }).env.E2E_VR_GATE = 'open';
		expect(await outcomeOf(open.platform, baseForm())).toBe(403);

		const closed = makeDb();
		(closed.platform as unknown as { env: Record<string, unknown> }).env.E2E_VR_GATE = 'false';
		expect(await outcomeOf(closed.platform, baseForm())).toBe(403);
	});
});
