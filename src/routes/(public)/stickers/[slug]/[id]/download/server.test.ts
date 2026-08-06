import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { makeD1 } from '$lib/server/test/d1';
import { animatedWebp } from '$lib/server/test/raster-fixtures';
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

	it('caches a plain download briefly at the edge only (s-maxage, not a browser hour)', async () => {
		// Takedowns must propagate promptly: the pre-menu hooks stamp gave downloads
		// s-maxage=300 + SWR, and the handler default must keep that — a
		// max-age=3600 default would pin removed files in browsers for an hour.
		const res = await GET(makeEvent(seedDb({ format: 'webp' })));
		expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=3600');
	});

	it('?format=png transforms via globalThis.fetch with cf.image options', async () => {
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const eventFetch = vi.fn(async () => new Response('orig')) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch }));
		// The documented in-Worker mechanism: fetch the image URL itself with
		// cf.image options. The /cdn-cgi/image/<url> form 404s from inside the
		// Worker (own-zone subrequests skip the edge and hit the origin).
		expect(transformFetch).toHaveBeenCalledWith(FILE, { cf: { image: { format: 'png' } } });
		// The event fetch buffers the original for the animation sniff, but must
		// NOT be used for the transform request (app-router-resolving,
		// cookie-carrying — the /cdn-cgi request would never leave the isolate).
		expect(eventFetch).toHaveBeenCalledWith(FILE);
		expect(eventFetch).not.toHaveBeenCalledWith(expect.stringContaining('/cdn-cgi/'));
		expect(res.headers.get('Content-Type')).toBe('image/png');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.png"');
	});

	it('serves the original (no-store) when a stale-flagged "static" row actually animates', async () => {
		// Pre-backfill hole: is_animated=0 lies, the stored bytes are an animated
		// WebP. The endpoint must sniff the buffered original and refuse the
		// flattening transform entirely — the transform fetch never happens.
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const eventFetch = vi.fn(async () =>
			new Response(animatedWebp().buffer as ArrayBuffer, { headers: { 'content-type': 'image/webp' } })
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp', isAnimated: 0 }), { search: '?format=png', fetch: eventFetch }));
		expect(transformFetch).not.toHaveBeenCalled();
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
		expect(res.headers.get('Cache-Control')).toBe('private, no-store');
	});

	it('502s a ?format=png request when the original cannot be fetched', async () => {
		// The converting path's buffered read must fail like the plain path does,
		// not throw an unhandled error out of arrayBuffer()/a bodyless response.
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const eventFetch = vi.fn(async () => new Response('gone', { status: 404 })) as typeof fetch;
		await expect(
			status(GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch })))
		).resolves.toBe(502);
		expect(transformFetch).not.toHaveBeenCalled();
	});

	it('streams the original untouched when content-length exceeds the 1MB convert cap', async () => {
		// Manual uploads can reach 10MB (MAX_BUFFER_BYTES); the public converting
		// path must not buffer that — it skips sniff-and-convert entirely and
		// serves the original like the plain path (memory-amplification guard).
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const eventFetch = vi.fn(async () =>
			new Response('big-bytes', {
				headers: { 'content-type': 'image/webp', 'content-length': '5000000' }
			})
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch }));
		expect(transformFetch).not.toHaveBeenCalled();
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
	});

	it('keeps the query string of an absolute source URL on the transform request', async () => {
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const db = seedDb({ format: 'webp', imageUrl: `${FILE}?v=2` });
		await GET(makeEvent(db, { search: '?format=png' }));
		// The whole URL (query included) is fetched — a signed/versioned source
		// must not lose its query.
		expect(transformFetch).toHaveBeenCalledWith(`${FILE}?v=2`, { cf: { image: { format: 'png' } } });
	});

	it('resolves a root-relative /img stored URL against the request origin', async () => {
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const db = seedDb({ format: 'webp', imageUrl: '/img/stickers/pack/key.webp' });
		await GET(makeEvent(db, { search: '?format=png' }));
		expect(transformFetch).toHaveBeenCalledWith(`${ORIGIN}/img/stickers/pack/key.webp`, { cf: { image: { format: 'png' } } });
	});

	it('normalizes dot segments out of a stored path before it reaches the transform', async () => {
		// transformableUrl relies on new URL() dot-segment normalization; pin it
		// so a refactor to naive string handling can't leak '..' into the fetched
		// URL.
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const db = seedDb({ format: 'webp', imageUrl: '/img/a/../../etc/x.webp' });
		await GET(makeEvent(db, { search: '?format=png' }));
		expect(transformFetch).toHaveBeenCalledTimes(1);
		const called = String(transformFetch.mock.calls[0][0]);
		expect(called).not.toContain('..');
		expect(called).toBe(`${ORIGIN}/etc/x.webp`);
	});

	it('falls back to the original bytes when the transform cannot run (SONA-21 off-zone)', async () => {
		stubTransformFetch(async () => new Response('forbidden', { status: 403 }));
		const eventFetch = vi.fn(async () =>
			new Response('orig-bytes', { headers: { 'content-type': 'image/webp' } })
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch }));
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
		// The fallback reuses the buffered original — no second origin fetch.
		expect(eventFetch).toHaveBeenCalledTimes(1);
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
