import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { isRedirect } from '@sveltejs/kit';
import { makeD1 } from '$lib/server/test/d1';
import { getDb } from '$lib/server/db';
import { clearSettingsCache } from '$lib/server/settings';
import { vrTabEnabled, clearVrTabCache } from '$lib/server/vr-gate';

import { actions } from './+page.server';

// Disposal probe: updateAvatar/deleteAvatar route replaced/removed model files
// through deleteFile (the eager best-effort pattern deletePack and the images/
// fursuit deletes use); the spy asserts which URLs get disposed of.
const deleteFileSpy = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('$lib/server/storage', async (importOriginal) => {
	const original = await importOriginal<typeof import('$lib/server/storage')>();
	return { ...original, deleteFile: deleteFileSpy };
});

beforeEach(() => {
	clearSettingsCache();
	deleteFileSpy.mockClear();
});

const NOW = '2026-01-01T00:00:00.000Z';
const MODEL_URL = 'https://cdn.example.com/vr-models/old.vrm';

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
		CREATE TABLE avatar_media (
			avatar_id INTEGER NOT NULL, kind TEXT NOT NULL, url TEXT NOT NULL,
			width INTEGER, height INTEGER, position INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE characters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
		CREATE TABLE images (
			id INTEGER PRIMARY KEY AUTOINCREMENT, image_url TEXT NOT NULL, thumbnail_url TEXT,
			title TEXT, file_size INTEGER, nsfw INTEGER NOT NULL DEFAULT 0, created_at TEXT
		);
	`);
	sqlite.prepare('INSERT INTO characters (id, name) VALUES (1, ?)').run('Taro');
	const d1 = makeD1(sqlite);
	// IMAGES makes the R2 provider constructible so validateAvatarMedia can
	// recognise self-hosted /img/… media URLs as owned.
	return { sqlite, platform: { env: { DB: d1, IMAGES: {} } } as unknown as App.Platform };
}

function addAvatar(
	sqlite: ReturnType<typeof makeDb>['sqlite'],
	opts: { slug?: string; published?: number; modelUrl?: string | null } = {}
) {
	return sqlite
		.prepare(
			`INSERT INTO vr_avatars (slug, name, character_id, model_url, model_format, model_size_bytes, published, created_at)
			 VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
		)
		.run(
			opts.slug ?? 'taro',
			'Taro',
			opts.modelUrl ?? null,
			opts.modelUrl ? 'vrm' : null,
			opts.modelUrl ? 1000 : null,
			opts.published ?? 0,
			NOW
		).lastInsertRowid as number;
}

function saveForm(overrides: Record<string, string> = {}): FormData {
	const form = new FormData();
	form.set('name', 'Taro');
	form.set('slug', 'taro');
	form.set('characterId', '1');
	for (const [k, v] of Object.entries(overrides)) form.set(k, v);
	return form;
}

async function run(
	action: 'save' | 'delete',
	platform: App.Platform,
	id: number,
	form?: FormData
): Promise<number | 'redirected'> {
	const request = new Request(`http://localhost/admin/vr/${id}/edit?/${action}`, {
		method: 'POST',
		body: form ?? new FormData()
	});
	const url = new URL(`http://localhost/admin/vr/${id}/edit`);
	try {
		const result = await actions[action]({ request, platform, params: { id: String(id) }, url } as never);
		return result && 'status' in (result as object) ? (result as { status: number }).status : 'redirected';
	} catch (e) {
		if (isRedirect(e)) return 'redirected';
		throw e;
	}
}

describe('save action', () => {
	it('allows editing a draft without publishing (data is the owner’s)', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { published: 0 });
		expect(await run('save', platform, id, saveForm({ description: 'updated' }))).toBe('redirected');
		const row = sqlite.prepare('SELECT description FROM vr_avatars WHERE id = ?').get(id) as {
			description: string;
		};
		expect(row.description).toBe('updated');
	});

	it('allows keeping an already-published avatar published', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { published: 1 });
		expect(await run('save', platform, id, saveForm({ published: '1' }))).toBe('redirected');
	});

	it('deletes a draft', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { published: 0 });
		expect(await run('delete', platform, id)).toBe('redirected');
		expect((sqlite.prepare('SELECT COUNT(*) AS n FROM vr_avatars').get() as { n: number }).n).toBe(0);
	});

	it('publishes a draft without any key (the SONA-124 gate retired at GA — SONA-157)', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { published: 0 });
		expect(await run('save', platform, id, saveForm({ published: '1' }))).toBe('redirected');
		const row = sqlite.prepare('SELECT published FROM vr_avatars WHERE id = ?').get(id) as {
			published: number;
		};
		expect(row.published).toBe(1);
	});
});

describe('model file disposal', () => {
	it('disposes of the previous model file when it is removed on save', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { modelUrl: MODEL_URL });
		expect(await run('save', platform, id, saveForm({ modelUrl: '' }))).toBe('redirected');
		expect(deleteFileSpy).toHaveBeenCalledTimes(1);
		expect(deleteFileSpy.mock.calls[0][2]).toBe(MODEL_URL);
	});

	it('disposes of the previous model file when it is replaced', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { modelUrl: MODEL_URL });
		const form = saveForm({
			modelUrl: 'https://cdn.example.com/vr-models/new.vrm',
			modelFormat: 'vrm',
			modelSizeBytes: '2000'
		});
		expect(await run('save', platform, id, form)).toBe('redirected');
		expect(deleteFileSpy).toHaveBeenCalledTimes(1);
		expect(deleteFileSpy.mock.calls[0][2]).toBe(MODEL_URL);
	});

	it('keeps the stored file when the model is unchanged', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { modelUrl: MODEL_URL });
		const form = saveForm({ modelUrl: MODEL_URL, modelFormat: 'vrm', modelSizeBytes: '1000' });
		expect(await run('save', platform, id, form)).toBe('redirected');
		expect(deleteFileSpy).not.toHaveBeenCalled();
	});

	it('replaces showcase media rows on save and disposes of the removed files', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite);
		sqlite
			.prepare('INSERT INTO avatar_media (avatar_id, kind, url, position) VALUES (?, ?, ?, 0)')
			.run(id, 'image', '/img/vr-media/old.png');
		const form = saveForm({
			'media[0][url]': '/img/vr-media/new.png',
			'media[0][kind]': 'image'
		});
		expect(await run('save', platform, id, form)).toBe('redirected');
		const rows = sqlite
			.prepare('SELECT url, position FROM avatar_media ORDER BY position')
			.all() as Array<{ url: string; position: number }>;
		expect(rows).toEqual([{ url: '/img/vr-media/new.png', position: 0 }]);
		// The dropped row's stored file goes with it (eager best-effort delete).
		expect(deleteFileSpy).toHaveBeenCalledTimes(1);
		expect(deleteFileSpy.mock.calls[0][2]).toBe('/img/vr-media/old.png');
	});

	it('keeps a media file that stays referenced across a save', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite);
		sqlite
			.prepare('INSERT INTO avatar_media (avatar_id, kind, url, position) VALUES (?, ?, ?, 0)')
			.run(id, 'image', '/img/vr-media/keep.png');
		const form = saveForm({
			'media[0][url]': '/img/vr-media/keep.png',
			'media[0][kind]': 'image'
		});
		expect(await run('save', platform, id, form)).toBe('redirected');
		expect(deleteFileSpy).not.toHaveBeenCalled();
	});

	it('clears the cached vr tab probe on save (a publish flip must show the tab immediately)', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { published: 0 });
		const db = getDb(platform.env.DB);
		// Prime the cached probe with "no published avatar exists".
		clearVrTabCache();
		expect(await vrTabEnabled(db)).toBe(false);

		expect(await run('save', platform, id, saveForm({ published: '1' }))).toBe('redirected');

		// No manual clear here — updateAvatar itself must have invalidated the
		// cache, or this still reads the primed `false` for up to the TTL.
		expect(await vrTabEnabled(db)).toBe(true);
	});

	it('clears the cached vr tab probe on delete (the tab must drop immediately)', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { published: 1 });
		const db = getDb(platform.env.DB);
		clearVrTabCache();
		expect(await vrTabEnabled(db)).toBe(true);

		expect(await run('delete', platform, id)).toBe('redirected');

		expect(await vrTabEnabled(db)).toBe(false);
	});

	it('on delete, disposes of the model and showcase media but never the poster image', async () => {
		const { sqlite, platform } = makeDb();
		const id = addAvatar(sqlite, { modelUrl: MODEL_URL });
		sqlite
			.prepare('INSERT INTO avatar_media (avatar_id, kind, url) VALUES (?, ?, ?)')
			.run(id, 'image', 'https://cdn.example.com/media/shot.png');
		expect(await run('delete', platform, id)).toBe('redirected');
		const disposed = deleteFileSpy.mock.calls.map((c) => c[2]);
		expect(disposed.sort()).toEqual([MODEL_URL, 'https://cdn.example.com/media/shot.png'].sort());
	});
});
