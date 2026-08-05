import { describe, it, expect, vi } from 'vitest';
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

describe('GET /stickers/[slug]/[id]/download', () => {
	it('serves the original bytes with the original filename by default', async () => {
		const res = await GET(makeEvent(seedDb({ format: 'webp' })));
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
	});

	it('?format=png proxies through the zone image transform', async () => {
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes('/cdn-cgi/image/')) {
				return new Response('png-bytes', { headers: { 'content-type': 'image/png' } });
			}
			return new Response('orig');
		}) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: fetchFn }));
		expect(fetchFn).toHaveBeenCalledWith(`${ORIGIN}/cdn-cgi/image/format=png/${FILE}`);
		expect(res.headers.get('Content-Type')).toBe('image/png');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.png"');
	});

	it('falls back to the original bytes when the transform cannot run (SONA-21 off-zone)', async () => {
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes('/cdn-cgi/image/')) return new Response('forbidden', { status: 403 });
			return new Response('orig-bytes', { headers: { 'content-type': 'image/webp' } });
		}) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: fetchFn }));
		expect(res.headers.get('Content-Type')).toBe('image/webp');
		expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="pack-7.webp"');
	});

	it('rejects a transform response that is not actually a PNG', async () => {
		// A transform-less zone can pass the source through, or an error page can
		// come back 200 — neither must be served under a .png name.
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes('/cdn-cgi/image/')) {
				return new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } });
			}
			return new Response('orig-bytes', { headers: { 'content-type': 'image/webp' } });
		}) as typeof fetch;
		const res = await GET(makeEvent(seedDb({ format: 'webp' }), { search: '?format=png', fetch: fetchFn }));
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
