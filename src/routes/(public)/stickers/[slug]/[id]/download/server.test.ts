import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { GET } from './+server';

const ORIGIN = 'https://site.example';
const FILE = 'https://cdn.example.com/stickers/pack/a.webp';

function seedDb(row: { format: string; isAnimated?: number; imageUrl?: string; published?: number }) {
	const sqlite = new Database(':memory:');
	sqlite.exec(`
		CREATE TABLE sticker_packs (id INTEGER PRIMARY KEY, slug TEXT, published INTEGER);
		CREATE TABLE stickers (id INTEGER PRIMARY KEY, pack_id INTEGER, image_url TEXT, format TEXT, is_animated INTEGER DEFAULT 0);
	`);
	sqlite.prepare('INSERT INTO sticker_packs (id, slug, published) VALUES (1, ?, ?)').run('pack', row.published ?? 1);
	sqlite
		.prepare('INSERT INTO stickers (id, pack_id, image_url, format, is_animated) VALUES (7, 1, ?, ?, ?)')
		.run(row.imageUrl ?? FILE, row.format, row.isAnimated ?? 0);
	return makeD1(sqlite);
}

let nextIp = 0;

function makeEvent(db: ReturnType<typeof makeD1>, opts: { search?: string; fetch?: typeof fetch } = {}) {
	return {
		params: { slug: 'pack', id: '7' },
		url: new URL(`${ORIGIN}/stickers/pack/7/download${opts.search ?? ''}`),
		platform: { env: { DB: db } },
		fetch: opts.fetch ?? (vi.fn(async () => new Response('bytes')) as typeof fetch),
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

/** Stub globalThis.fetch (the transform path uses it, NOT the event fetch, so
 * the /cdn-cgi/image request leaves the isolate instead of re-entering the app
 * router with the caller's cookies). */
function stubTransformFetch(impl: (input: RequestInfo | URL) => Promise<Response>) {
	const fn = vi.fn(impl);
	vi.stubGlobal('fetch', fn as typeof fetch);
	return fn;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('GET /stickers/[slug]/[id]/download', () => {
	it('serves the original bytes with the original filename by default', async () => {
		const res = await GET(makeEvent(seedDb({ format: 'webp' })));
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
	});

	it('?format=png proxies through the zone image transform via globalThis.fetch', async () => {
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const eventFetch = vi.fn(async () => new Response('orig')) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch }));
		expect(transformFetch).toHaveBeenCalledWith(`${ORIGIN}/cdn-cgi/image/format=png/${FILE}`);
		// The event fetch (app-router-resolving, cookie-carrying) must NOT be used
		// for the transform request.
		expect(eventFetch).not.toHaveBeenCalled();
		expect(res.headers.get('Content-Type')).toBe('image/png');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.png"');
	});

	it('keeps the query string of an absolute source URL on the transform request', async () => {
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const db = seedDb({ format: 'webp', imageUrl: `${FILE}?v=2` });
		await GET(makeEvent(db, { search: '?format=png' }));
		// Naive concat used to leak the query onto the transform path incorrectly;
		// for an off-origin absolute the WHOLE URL (query included) is the source.
		expect(transformFetch).toHaveBeenCalledWith(`${ORIGIN}/cdn-cgi/image/format=png/${FILE}?v=2`);
	});

	it('builds a clean transform path for a root-relative /img stored URL', async () => {
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const db = seedDb({ format: 'webp', imageUrl: '/img/stickers/pack/key.webp' });
		await GET(makeEvent(db, { search: '?format=png' }));
		// No doubled slash: the same-origin source rides along as a bare path.
		expect(transformFetch).toHaveBeenCalledWith(`${ORIGIN}/cdn-cgi/image/format=png/img/stickers/pack/key.webp`);
	});

	it('falls back to the original bytes when the transform cannot run (SONA-21 off-zone)', async () => {
		stubTransformFetch(async () => new Response('forbidden', { status: 403 }));
		const eventFetch = vi.fn(async () =>
			new Response('orig-bytes', { headers: { 'content-type': 'image/webp' } })
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch }));
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
	});

	it('marks a fallback-from-png response uncacheable (no edge-cached webp under the png URL)', async () => {
		stubTransformFetch(async () => new Response('forbidden', { status: 403 }));
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png' }));
		// A transient transform failure must not be pinned to ?format=png by the
		// edge (hooks.server.ts honors this explicit header instead of stamping
		// its public s-maxage default).
		expect(res.headers.get('Cache-Control')).toBe('private, no-store');
	});

	it('rejects a transform response that is not actually a PNG', async () => {
		// A transform-less zone can pass the source through, or an error page can
		// come back 200 — neither must be served under a .png name.
		stubTransformFetch(async () =>
			new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } })
		);
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png' }));
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
	});

	it('400s a PNG request for an animated raster (would flatten)', async () => {
		await expect(status(GET(makeEvent(seedDb({ format: 'webp', isAnimated: 1 }), { search: '?format=png' })))).resolves.toBe(400);
	});

	it('400s a PNG request for video, Lottie, and already-PNG stickers', async () => {
		await expect(
			status(GET(makeEvent(seedDb({ format: 'video', isAnimated: 1, imageUrl: `${FILE}.webm` }), { search: '?format=png' })))
		).resolves.toBe(400);
		await expect(
			status(GET(makeEvent(seedDb({ format: 'animated', isAnimated: 1, imageUrl: `${FILE}.json` }), { search: '?format=png' })))
		).resolves.toBe(400);
		await expect(
			status(GET(makeEvent(seedDb({ format: 'png', imageUrl: 'https://cdn.example.com/a.png' }), { search: '?format=png' })))
		).resolves.toBe(400);
	});

	it('400s an unknown format value', async () => {
		await expect(status(GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=gif' })))).resolves.toBe(400);
	});

	it('404s an unpublished pack', async () => {
		await expect(status(GET(makeEvent(seedDb({ format: 'webp', published: 0 }))))).resolves.toBe(404);
	});

	it('serves animated rasters as their original file (no flattening path exists)', async () => {
		const res = await GET(makeEvent(seedDb({ format: 'webp', isAnimated: 1 })));
		expect(res.headers.get('Content-Type')).toBe('image/webp');
	});
});
