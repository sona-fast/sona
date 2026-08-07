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

/**
 * An origin response that declares its length, like R2 and UploadThing do.
 * The converting path only buffers a body whose size it knows, so a fixture
 * without content-length exercises the stream-through branch instead of the
 * sniff-and-convert one — `new Response(body)` alone sets no such header.
 */
function originResponse(body: string, headers: Record<string, string> = {}) {
	return new Response(body, {
		headers: { 'content-length': String(new TextEncoder().encode(body).length), ...headers }
	});
}

function makeEvent(db: ReturnType<typeof makeD1>, opts: { search?: string; fetch?: typeof fetch } = {}) {
	return {
		params: { slug: 'pack', id: '7' },
		url: new URL(`${ORIGIN}/stickers/pack/7/download${opts.search ?? ''}`),
		platform: { env: { DB: db } },
		fetch: opts.fetch ?? (vi.fn(async () => originResponse('bytes')) as typeof fetch),
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
	// The console.warn spy below is a real spy on a global; without this it stays
	// installed for the rest of the file.
	vi.restoreAllMocks();
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
		const eventFetch = vi.fn(async () => originResponse('orig')) as typeof fetch;
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
			new Response(animatedWebp().buffer as ArrayBuffer, {
				headers: {
					'content-type': 'image/webp',
					'content-length': String(animatedWebp().byteLength)
				}
			})
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
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const eventFetch = vi.fn(async () =>
			new Response('big-bytes', {
				headers: { 'content-type': 'image/webp', 'content-length': '5000000' }
			})
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch }));
		expect(transformFetch).not.toHaveBeenCalled();
		// Over-cap is the guard working as designed, not a surprise — it must not
		// warn, or the log fills with noise and the undeclared-length case (which
		// does warn) stops standing out.
		expect(warn).not.toHaveBeenCalled();
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
	});

	it('streams through when the origin declares no content-length at all', async () => {
		// The cap read a missing header as Number(null) === 0, which is not > the
		// cap, so an undeclared body — a chunked response, exactly the case where
		// the size is unknown — fell through to an unbounded arrayBuffer(). No
		// declared length now means the non-buffering path.
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const eventFetch = vi.fn(async () =>
			// A ReadableStream body, mirroring a chunked origin — the shape this
			// branch exists for. (A string body sets no content-length either; the
			// fixtures that need one declare it explicitly, via originResponse.)
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode('streamed-bytes'));
						c.close();
					}
				}),
				{ headers: { 'content-type': 'image/webp' } }
			)
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch }));

		expect(transformFetch).not.toHaveBeenCalled();
		// The user asked for PNG and got webp. Without a log line that downgrade is
		// invisible, so the branch has to say so — naming the host that behaved
		// unexpectedly, since that is what a fork operator has to go look at.
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('cdn.example.com'));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped png conversion'));
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
		// Original bytes under a ?format=png URL, so the same no-store the other
		// two fallbacks carry — otherwise the edge pins webp to the png URL.
		expect(res.headers.get('Cache-Control')).toBe('private, no-store');
		// And the original bytes reach the client untouched.
		expect(await res.text()).toBe('streamed-bytes');
	});

	it('streams through when content-length is not a number', async () => {
		// NaN loses every comparison, so a malformed header slipped under the cap
		// the same way a missing one did.
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const eventFetch = vi.fn(async () =>
			new Response('orig-bytes', {
				headers: { 'content-type': 'image/webp', 'content-length': 'banana' }
			})
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch }));

		expect(transformFetch).not.toHaveBeenCalled();
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
	});

	it('still converts when the declared length is within the cap', async () => {
		// The guard must not have swallowed the normal path along with the holes.
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const eventFetch = vi.fn(async () =>
			originResponse('orig', { 'content-type': 'image/webp' })
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch }));

		expect(transformFetch).toHaveBeenCalled();
		expect(res.headers.get('Content-Type')).toBe('image/png');
	});

	it('forwards the origin ETag, and drops Last-Modified', async () => {
		// The ETag lets a repeat download revalidate to a 304 instead of pulling the
		// whole file again. Last-Modified does the opposite here: Cache-Control
		// gives the browser no freshness lifetime of its own (s-maxage binds shared
		// caches only), so a Last-Modified switches on heuristic freshness and
		// Chrome stops revalidating altogether — measured, not theoretical.
		const eventFetch = vi.fn(async () =>
			new Response('bytes', {
				headers: {
					'content-type': 'image/webp',
					etag: '"abc123"',
					'last-modified': 'Wed, 06 Aug 2026 10:00:00 GMT'
				}
			})
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { fetch: eventFetch }));

		expect(res.headers.get('ETag')).toBe('"abc123"');
		expect(res.headers.get('Last-Modified')).toBeNull();
	});

	it('omits the validator when the origin sends none', async () => {
		const eventFetch = vi.fn(async () =>
			new Response('bytes', { headers: { 'content-type': 'image/webp' } })
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { fetch: eventFetch }));

		expect(res.headers.get('ETag')).toBeNull();
		expect(res.headers.get('Last-Modified')).toBeNull();
	});

	it('502s when the origin sends more bytes than it declared', async () => {
		// content-length is the origin's claim, and it is what selects the buffering
		// path. A response declaring 4 bytes and then streaming megabytes would
		// otherwise walk straight past the cap the declared-size check enforces.
		const transformFetch = stubTransformFetch(async () =>
			new Response('png-bytes', { headers: { 'content-type': 'image/png' } })
		);
		const eventFetch = vi.fn(async () =>
			new Response(
				new ReadableStream({
					start(c) {
						for (let i = 0; i < 12; i++) c.enqueue(new Uint8Array(100_000));
						c.close();
					}
				}),
				{ headers: { 'content-type': 'image/webp', 'content-length': '4' } }
			)
		) as typeof fetch;
		await expect(
			status(GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch })))
		).resolves.toBe(502);
		expect(transformFetch).not.toHaveBeenCalled();
	});

	it('forwards the transformed response validators on the png path', async () => {
		// Not the original's — these must describe the PNG actually being sent.
		stubTransformFetch(async () =>
			new Response('png-bytes', {
				headers: { 'content-type': 'image/png', etag: '"png-etag"' }
			})
		);
		const eventFetch = vi.fn(async () =>
			originResponse('orig', { 'content-type': 'image/webp', etag: '"orig-etag"' })
		) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: eventFetch }));

		expect(res.headers.get('Content-Type')).toBe('image/png');
		expect(res.headers.get('ETag')).toBe('"png-etag"');
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
			originResponse('orig-bytes', { 'content-type': 'image/webp' })
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
