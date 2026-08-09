import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
	permissionSource?: string | null;
	modelUrl?: string | null;
	modelFormat?: string | null;
	r2PublicUrl?: string;
	storageProvider?: string;
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
	const setSetting = sqlite.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)');
	setSetting.run('r2PublicUrl', row.r2PublicUrl ?? CDN);
	if (row.storageProvider) setSetting.run('storageProvider', row.storageProvider);
	sqlite
		.prepare(
			`INSERT INTO vr_avatars (slug, name, character_id, model_url, model_format, license, permission_source, downloadable, published, created_at)
			 VALUES ('foxo', 'Foxo VR', 1, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			row.modelUrl === undefined ? `${CDN}/models/foxo.vrm` : row.modelUrl,
			row.modelFormat === undefined ? 'vrm' : row.modelFormat,
			row.license === undefined ? 'personal-use' : row.license,
			// A recorded permission grant is part of the default HAPPY path now —
			// the download 403s without one (compliance C1).
			row.permissionSource === undefined ? 'Telegram DM 2026-08-01' : row.permissionSource,
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
	db: ReturnType<typeof seedDb>,
	opts: {
		slug?: string;
		images?: ReturnType<typeof makeImages>;
		uploadthingToken?: string;
		ip?: string;
	} = {}
) {
	const slug = opts.slug ?? 'foxo';
	return {
		params: { slug },
		url: new URL(`${ORIGIN}/vr/${slug}/download`),
		platform: {
			env: {
				DB: db,
				IMAGES: opts.images ?? makeImages(),
				...(opts.uploadthingToken ? { UPLOADTHING_TOKEN: opts.uploadthingToken } : {})
			}
		},
		// Unique per event so the module-level rate limiter never trips across tests.
		getClientAddress: () => opts.ip ?? `10.0.0.${nextIp++}`
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
afterEach(() => vi.unstubAllGlobals());

describe('GET /vr/[slug]/download — enforcement matrix', () => {
	it('serves a published, downloadable, permissively-licensed model with recorded permission', async () => {
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

	it('403s without a recorded permission source, even when everything else allows (C1)', async () => {
		// No permission record, no redistribution — the fursuit rule. The flag +
		// license can't override a missing grant.
		await expect(status(GET(makeEvent(seedDb({ permissionSource: null }))))).resolves.toBe(403);
	});

	it('404s when the object is missing from the bucket', async () => {
		const db = seedDb({});
		await expect(status(GET(makeEvent(db, { images: makeImages({}) })))).resolves.toBe(404);
	});

	// NOTE the enforcement above guards the OFFER (the forced-download
	// affordance), not byte secrecy: the viewer endpoint /vr/[slug]/model serves
	// the same bytes for any published VRM regardless of license, by design.
});

describe('GET /vr/[slug]/download — byte resolution (resolveModelBytes)', () => {
	it('maps the stored URL through the base-agnostic deleteOrphans key rule to the bucket key', async () => {
		const images = makeImages();
		await GET(makeEvent(seedDb({}), { images }));
		expect(images.get).toHaveBeenCalledWith('models/foxo.vrm');
	});

	it('resolves an /img-relative stored URL to its key', async () => {
		const images = makeImages();
		await GET(makeEvent(seedDb({ modelUrl: '/img/models/foxo.vrm' }), { images }));
		expect(images.get).toHaveBeenCalledWith('models/foxo.vrm');
	});

	it('still serves a model stored under a FORMER r2PublicUrl (base changed after upload)', async () => {
		// The D5 case: r2PublicUrl was changed after the upload, so the stored URL
		// no longer matches the current base — the pathname key must still hit.
		const db = seedDb({ modelUrl: 'https://old-cdn.example/models/foxo.vrm', r2PublicUrl: CDN });
		const res = await GET(makeEvent(db));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('MODEL BYTES');
	});

	it('404s a URL whose path maps to no stored object and no provider owns', async () => {
		const images = makeImages({});
		const db = seedDb({ modelUrl: 'https://elsewhere.example/other/nope.vrm' });
		await expect(status(GET(makeEvent(db, { images })))).resolves.toBe(404);
		expect(images.get).toHaveBeenCalledWith('other/nope.vrm');
	});

	it('proxies an UploadThing-owned model URL through an outbound fetch (D1)', async () => {
		// UploadThing fork: bytes live at utfs.io, not in R2 — the route must
		// stream them through rather than 404ing forever.
		const fetchMock = vi.fn(async () => new Response('UT BYTES', { headers: { 'content-length': '8' } }));
		vi.stubGlobal('fetch', fetchMock);
		const db = seedDb({
			modelUrl: 'https://utfs.io/f/abc123',
			storageProvider: 'uploadthing'
		});
		const res = await GET(makeEvent(db, { images: makeImages({}), uploadthingToken: 'tkn' }));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('UT BYTES');
		expect(fetchMock).toHaveBeenCalledWith('https://utfs.io/f/abc123');
	});

	it('does NOT proxy a foreign URL the provider does not own (no SSRF)', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const db = seedDb({
			modelUrl: 'https://elsewhere.example/other/nope.vrm',
			storageProvider: 'uploadthing'
		});
		await expect(
			status(GET(makeEvent(db, { images: makeImages({}), uploadthingToken: 'tkn' })))
		).resolves.toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('GET /vr/[slug]/download — serving details', () => {
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

	it('429s the 21st download from one IP inside the window (rate limiter wired)', async () => {
		const ip = '203.0.113.77';
		const db = seedDb({});
		for (let i = 0; i < 20; i++) {
			await expect(status(GET(makeEvent(db, { ip })))).resolves.toBe(200);
		}
		await expect(status(GET(makeEvent(db, { ip })))).resolves.toBe(429);
	});
});
