import { describe, it, expect, beforeEach, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { clearSettingsCache } from '$lib/server/settings';

import { GET } from './+server';

const ORIGIN = 'https://site.example';
const CDN = 'https://cdn.example.com';
const NOW = '2026-01-01T00:00:00.000Z';

function seedDb(row: {
	published?: number;
	downloadable?: number;
	license?: string | null;
	modelUrl?: string | null;
	modelFormat?: string | null;
	r2PublicUrl?: string;
}) {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE vr_avatars (
			id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL, name TEXT NOT NULL,
			character_id INTEGER NOT NULL, model_url TEXT, model_format TEXT,
			model_size_bytes INTEGER, poster_image_id INTEGER, external_url TEXT,
			license TEXT, permission_source TEXT, downloadable INTEGER NOT NULL DEFAULT 0,
			nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
			description TEXT, created_at TEXT NOT NULL
		);
	`);
	sqlite
		.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)')
		.run('r2PublicUrl', row.r2PublicUrl ?? CDN);
	sqlite
		.prepare(
			`INSERT INTO vr_avatars (slug, name, character_id, model_url, model_format, license, downloadable, published, created_at)
			 VALUES ('foxo', 'Foxo VR', 1, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			row.modelUrl === undefined ? `${CDN}/models/foxo.vrm` : row.modelUrl,
			row.modelFormat === undefined ? 'vrm' : row.modelFormat,
			row.license === undefined ? 'personal-use' : row.license,
			row.downloadable ?? 1,
			row.published ?? 1,
			NOW
		);
	return makeD1(sqlite);
}

/** Minimal R2 binding: get() resolves the seeded key to a streamed object. */
function makeImages(keys: Record<string, string> = { 'models/foxo.vrm': 'MODEL BYTES' }) {
	return {
		get: vi.fn(async (key: string) => {
			const body = keys[key];
			if (body === undefined) return null;
			return {
				body: new Response(body).body,
				size: new TextEncoder().encode(body).length,
				httpEtag: '"model-etag"',
				httpMetadata: {}
			};
		})
	};
}

let nextIp = 0;

function makeEvent(
	db: ReturnType<typeof makeD1>,
	opts: { slug?: string; images?: ReturnType<typeof makeImages> } = {}
) {
	const slug = opts.slug ?? 'foxo';
	return {
		params: { slug },
		url: new URL(`${ORIGIN}/vr/${slug}/download`),
		platform: { env: { DB: db, IMAGES: opts.images ?? makeImages() } },
		// Unique per event so the module-level rate limiter never trips across tests.
		getClientAddress: () => `10.0.0.${nextIp++}`
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
}

async function status(promise: Response | Promise<Response>): Promise<number> {
	try {
		return (await promise).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
}

// getSettings caches per isolate; each test seeds its own r2PublicUrl.
beforeEach(() => clearSettingsCache());

describe('GET /vr/[slug]/download — enforcement matrix', () => {
	it('serves a published, downloadable, permissively-licensed model', async () => {
		const res = await GET(makeEvent(seedDb({ license: 'personal-use' })));
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="foxo.vrm"');
		expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
		expect(await res.text()).toBe('MODEL BYTES');
	});

	it('serves under cc-by too', async () => {
		await expect(status(GET(makeEvent(seedDb({ license: 'cc-by' }))))).resolves.toBe(200);
	});

	it('404s an unknown slug', async () => {
		await expect(status(GET(makeEvent(seedDb({}), { slug: 'nope' })))).resolves.toBe(404);
	});

	it('404s an unpublished avatar (indistinguishable from unknown)', async () => {
		await expect(status(GET(makeEvent(seedDb({ published: 0 }))))).resolves.toBe(404);
	});

	it('404s when no self-hosted model exists', async () => {
		await expect(status(GET(makeEvent(seedDb({ modelUrl: null }))))).resolves.toBe(404);
	});

	it('403s when downloadable is off, even with a permissive license', async () => {
		await expect(status(GET(makeEvent(seedDb({ downloadable: 0 }))))).resolves.toBe(403);
	});

	it('403s restrictive licenses even with downloadable=true', async () => {
		await expect(status(GET(makeEvent(seedDb({ license: 'base-tos' }))))).resolves.toBe(403);
		await expect(status(GET(makeEvent(seedDb({ license: 'all-rights-reserved' }))))).resolves.toBe(403);
		await expect(status(GET(makeEvent(seedDb({ license: null }))))).resolves.toBe(403);
	});

	it('404s a foreign-host model URL instead of streaming a key it spells', async () => {
		const images = makeImages({ 'models/foxo.vrm': 'MODEL BYTES' });
		const db = seedDb({ modelUrl: 'https://elsewhere.example/models/foxo.vrm' });
		await expect(status(GET(makeEvent(db, { images })))).resolves.toBe(404);
		expect(images.get).not.toHaveBeenCalled();
	});

	it('404s when the object is missing from the bucket', async () => {
		const db = seedDb({});
		await expect(status(GET(makeEvent(db, { images: makeImages({}) })))).resolves.toBe(404);
	});
});

describe('GET /vr/[slug]/download — serving details', () => {
	it('maps the stored URL through the deleteOrphans key rule to the bucket key', async () => {
		const images = makeImages();
		await GET(makeEvent(seedDb({}), { images }));
		expect(images.get).toHaveBeenCalledWith('models/foxo.vrm');
	});

	it('resolves an /img-relative stored URL to its key', async () => {
		const images = makeImages();
		await GET(makeEvent(seedDb({ modelUrl: '/img/models/foxo.vrm' }), { images }));
		expect(images.get).toHaveBeenCalledWith('models/foxo.vrm');
	});

	it('names an fbx download foxo.fbx and a vrm0 one foxo.vrm', async () => {
		const fbx = await GET(makeEvent(seedDb({ modelFormat: 'fbx' })));
		expect(fbx.headers.get('Content-Disposition')).toBe('attachment; filename="foxo.fbx"');
		const vrm0 = await GET(makeEvent(seedDb({ modelFormat: 'vrm0' })));
		expect(vrm0.headers.get('Content-Disposition')).toBe('attachment; filename="foxo.vrm"');
	});

	it('declares length + validator and a short shared-cache TTL (takedown propagation)', async () => {
		const res = await GET(makeEvent(seedDb({})));
		expect(res.headers.get('content-length')).toBe(String('MODEL BYTES'.length));
		expect(res.headers.get('etag')).toBe('"model-etag"');
		expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=3600');
	});
});
