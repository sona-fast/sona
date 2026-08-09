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
			 VALUES ('foxo', 'Foxo VR', 1, ?, ?, ?, 0, ?, ?)`
		)
		.run(
			row.modelUrl === undefined ? `${CDN}/models/foxo.vrm` : row.modelUrl,
			row.modelFormat === undefined ? 'vrm' : row.modelFormat,
			row.license === undefined ? 'all-rights-reserved' : row.license,
			row.published ?? 1,
			NOW
		);
	return makeD1(sqlite);
}

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
		ip?: string;
		headers?: Record<string, string>;
		uploadthingToken?: string;
	} = {}
) {
	const slug = opts.slug ?? 'foxo';
	return {
		params: { slug },
		request: new Request(`${ORIGIN}/vr/${slug}/model`, { headers: opts.headers }),
		url: new URL(`${ORIGIN}/vr/${slug}/model`),
		platform: {
			env: {
				DB: db,
				IMAGES: opts.images ?? makeImages(),
				...(opts.uploadthingToken ? { UPLOADTHING_TOKEN: opts.uploadthingToken } : {})
			}
		},
		getClientAddress: () => opts.ip ?? `10.1.0.${nextIp++}`
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

beforeEach(() => clearSettingsCache());

describe('GET /vr/[slug]/model — viewer bytes', () => {
	it('serves a published VRM regardless of license (viewing is not the offer)', async () => {
		// Deliberate: the download 403 enforces the OFFER, not byte secrecy — a
		// viewable model is a fetchable model (design-doc decision). The default
		// fixture is all-rights-reserved + downloadable=0 and still serves here.
		const res = await GET(makeEvent(seedDb({})));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('MODEL BYTES');
	});

	it('sends octet-stream + nosniff and a SHORT, non-immutable shared-cache TTL', async () => {
		// NOT the /img route's immutable 1y: revocation (unpublish/removal) must
		// propagate through shared caches; the short browser max-age just spares
		// repeat views the multi-MB re-transfer.
		const res = await GET(makeEvent(seedDb({})));
		expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Cache-Control')).toBe(
			'public, max-age=60, s-maxage=300'
		);
		expect(res.headers.get('content-length')).toBe(String('MODEL BYTES'.length));
		expect(res.headers.get('etag')).toBe('"model-etag"');
	});

	it('answers 304 (no body) to a matching If-None-Match revalidation', async () => {
		const res = await GET(
			makeEvent(seedDb({}), { headers: { 'if-none-match': '"model-etag"' } })
		);
		expect(res.status).toBe(304);
		expect(res.headers.get('etag')).toBe('"model-etag"');
		expect(await res.text()).toBe('');
	});

	it('re-streams the body when If-None-Match does not match', async () => {
		const res = await GET(makeEvent(seedDb({}), { headers: { 'if-none-match': '"stale"' } }));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('MODEL BYTES');
	});

	it('404s unknown, unpublished, model-less and FBX avatars alike', async () => {
		await expect(status(GET(makeEvent(seedDb({}), { slug: 'nope' })))).resolves.toBe(404);
		await expect(status(GET(makeEvent(seedDb({ published: 0 }))))).resolves.toBe(404);
		await expect(status(GET(makeEvent(seedDb({ modelUrl: null }))))).resolves.toBe(404);
		// FBX: the in-page viewer never consumes it, so this route has no reason
		// to hand it out (the old /img path leaked FBX bytes to anyone).
		await expect(
			status(GET(makeEvent(seedDb({ modelUrl: `${CDN}/models/foxo.fbx`, modelFormat: 'fbx' }))))
		).resolves.toBe(404);
	});

	it('404s when nothing resolves the stored URL', async () => {
		await expect(
			status(GET(makeEvent(seedDb({}), { images: makeImages({}) })))
		).resolves.toBe(404);
	});

	it('serves a model stored under a FORMER r2PublicUrl (base-agnostic key rule)', async () => {
		const db = seedDb({ modelUrl: 'https://old-cdn.example/models/foxo.vrm' });
		await expect(status(GET(makeEvent(db)))).resolves.toBe(200);
	});

	it('429s the 21st fetch from one IP inside the window', async () => {
		const ip = '203.0.113.99';
		const db = seedDb({});
		for (let i = 0; i < 20; i++) {
			await expect(status(GET(makeEvent(db, { ip })))).resolves.toBe(200);
		}
		await expect(status(GET(makeEvent(db, { ip })))).resolves.toBe(429);
	});
});

describe('GET /vr/[slug]/model — provider-fetch resolution (R2-D1/R2-D6)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('proxies an UploadThing-owned URL even when UT is NOT the active provider', async () => {
		// The D1 case: model uploaded while UploadThing was active, provider later
		// switched to R2 (the default here) — the bytes must still resolve, or
		// viewer AND download 404 forever.
		const fetchMock = vi.fn(
			async () => new Response('UT BYTES', { headers: { 'content-length': '8' } })
		);
		vi.stubGlobal('fetch', fetchMock);
		const db = seedDb({ modelUrl: 'https://utfs.io/f/abc123' });
		const res = await GET(makeEvent(db, { images: makeImages({}), uploadthingToken: 'tkn' }));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('UT BYTES');
		expect(res.headers.get('content-length')).toBe('8');
		// redirect: 'manual' — a provider 3xx must not bounce the stream off-host.
		expect(fetchMock).toHaveBeenCalledWith(
			'https://utfs.io/f/abc123',
			expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) })
		);
	});

	it('omits content-length when the provider declares no size (progress degrades, stream works)', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('UT BYTES')));
		const db = seedDb({ modelUrl: 'https://utfs.io/f/abc123' });
		const res = await GET(makeEvent(db, { images: makeImages({}), uploadthingToken: 'tkn' }));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBeNull();
		expect(await res.text()).toBe('UT BYTES');
	});
});
