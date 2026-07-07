import { describe, it, expect, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { isHttpError } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '$lib/server/db/schema';
import { images } from '$lib/server/db/schema';
import { GET } from './+server';

// Thin better-sqlite3 shim over the D1Database surface drizzle's d1 driver uses.
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
	sqlite.exec(`CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
		slug TEXT NOT NULL, image_url TEXT NOT NULL, thumbnail_url TEXT, width INTEGER, height INTEGER,
		file_size INTEGER, md5hash TEXT, nsfw INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
		source_post_url TEXT, artist_id INTEGER NOT NULL, collection_id INTEGER, commissioned_at TEXT,
		parent_image_id INTEGER, variant_label TEXT, created_at TEXT NOT NULL);`);
	const d1 = makeD1(sqlite);
	return { db: drizzle(d1, { schema }), platform: { env: { DB: d1 } } as unknown as App.Platform };
}

function makeEvent(platform: App.Platform, query: string, fetchMock: typeof fetch) {
	return {
		platform,
		url: new URL(`https://taro.surf/api/admin/ref-image${query}`),
		fetch: fetchMock
	} as never;
}

async function statusOf(fn: () => unknown): Promise<number> {
	try {
		await fn();
		return 200;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

describe('GET /api/admin/ref-image — by-ID image proxy', () => {
	it('streams the stored image bytes with the upstream content type', async () => {
		const { db, platform } = makeDb();
		const row = await db
			.insert(images)
			.values({ title: 'ref', slug: 'ref', imageUrl: 'https://cdn.x/ref.png', artistId: 1, createdAt: '2026-01-01' })
			.returning({ id: images.id })
			.get();
		const fetchMock = vi.fn(
			async () => new Response('PNGBYTES', { status: 200, headers: { 'content-type': 'image/png' } })
		) as unknown as typeof fetch;

		const res = (await GET(makeEvent(platform, `?id=${row.id}`, fetchMock))) as Response;

		// Fetched the DB-stored URL — never a caller-supplied one — and never
		// follows a redirect away from it.
		expect(vi.mocked(fetchMock)).toHaveBeenCalledWith('https://cdn.x/ref.png', {
			redirect: 'manual'
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('content-disposition')).toBe('inline');
		expect(await res.text()).toBe('PNGBYTES');
	});

	it('coerces a non-image upstream content type to application/octet-stream', async () => {
		const { db, platform } = makeDb();
		const row = await db
			.insert(images)
			.values({ title: 'ref', slug: 'ref', imageUrl: 'https://cdn.x/ref.png', artistId: 1, createdAt: '2026-01-01' })
			.returning({ id: images.id })
			.get();
		const fetchMock = vi.fn(
			async () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
		) as unknown as typeof fetch;

		const res = (await GET(makeEvent(platform, `?id=${row.id}`, fetchMock))) as Response;

		expect(res.headers.get('content-type')).toBe('application/octet-stream');
	});

	it('502s on an upstream redirect instead of following it', async () => {
		const { db, platform } = makeDb();
		const row = await db
			.insert(images)
			.values({ title: 'ref', slug: 'ref', imageUrl: 'https://cdn.x/ref.png', artistId: 1, createdAt: '2026-01-01' })
			.returning({ id: images.id })
			.get();
		const fetchMock = vi.fn(
			async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
		) as unknown as typeof fetch;

		expect(await statusOf(() => GET(makeEvent(platform, `?id=${row.id}`, fetchMock)))).toBe(502);
	});

	it('rejects private / link-local stored hosts WITHOUT fetching', async () => {
		const urls = [
			'https://localhost/x.png',
			'https://127.0.0.1/x.png',
			'https://10.1.2.3/x.png',
			'https://192.168.0.9/x.png',
			'https://172.16.0.1/x.png',
			'https://172.31.9.9/x.png',
			'https://169.254.1.1/x.png',
			'http://[::1]/x.png',
			// Hardened round 2: trailing-dot FQDN, unspecified, IPv4-mapped IPv6
			// (raw dotted + the WHATWG-normalized hex form), ULA, link-local.
			'https://localhost./x.png',
			'https://0.0.0.0/x.png',
			'http://[::ffff:127.0.0.1]/x.png',
			'http://[::ffff:c0a8:9]/x.png',
			'http://[fc00::1]/x.png',
			'http://[fd12:3456::1]/x.png',
			'http://[fe80::1]/x.png',
			// Round 4: IPv6 unspecified — connect() reaches loopback like 0.0.0.0.
			'http://[::]/x.png'
		];
		for (const imageUrl of urls) {
			const { db, platform } = makeDb();
			const row = await db
				.insert(images)
				.values({ title: 'ref', slug: 'ref', imageUrl, artistId: 1, createdAt: '2026-01-01' })
				.returning({ id: images.id })
				.get();
			const fetchMock = vi.fn() as unknown as typeof fetch;

			expect(await statusOf(() => GET(makeEvent(platform, `?id=${row.id}`, fetchMock)))).toBe(502);
			expect(vi.mocked(fetchMock)).not.toHaveBeenCalled();
		}
	});

	it('still allows public hosts that merely resemble private prefixes', async () => {
		const urls = [
			'https://172.200.0.1/x.png',
			'https://cdn.example.com/x.png',
			'http://[2606:4700::6810:84e5]/x.png' // public IPv6 — not ::1 / ULA / link-local
		];
		for (const imageUrl of urls) {
			const { db, platform } = makeDb();
			const row = await db
				.insert(images)
				.values({ title: 'ref', slug: 'ref', imageUrl, artistId: 1, createdAt: '2026-01-01' })
				.returning({ id: images.id })
				.get();
			const fetchMock = vi.fn(
				async () => new Response('PNGBYTES', { status: 200, headers: { 'content-type': 'image/png' } })
			) as unknown as typeof fetch;

			const res = (await GET(makeEvent(platform, `?id=${row.id}`, fetchMock))) as Response;
			expect(res.status).toBe(200);
		}
	});

	it('404s for an unknown image id without fetching anything', async () => {
		const { platform } = makeDb();
		const fetchMock = vi.fn() as unknown as typeof fetch;

		expect(await statusOf(() => GET(makeEvent(platform, '?id=999', fetchMock)))).toBe(404);
		expect(vi.mocked(fetchMock)).not.toHaveBeenCalled();
	});

	it('400s for missing or non-integer ids (no URL parameter exists at all)', async () => {
		const { platform } = makeDb();
		const fetchMock = vi.fn() as unknown as typeof fetch;

		expect(await statusOf(() => GET(makeEvent(platform, '', fetchMock)))).toBe(400);
		expect(await statusOf(() => GET(makeEvent(platform, '?id=abc', fetchMock)))).toBe(400);
		expect(await statusOf(() => GET(makeEvent(platform, '?id=1.5', fetchMock)))).toBe(400);
		expect(await statusOf(() => GET(makeEvent(platform, '?id=-1', fetchMock)))).toBe(400);
		// A url param is ignored — only the id is ever consulted (SSRF guard).
		expect(
			await statusOf(() => GET(makeEvent(platform, '?url=https://evil.example', fetchMock)))
		).toBe(400);
		expect(vi.mocked(fetchMock)).not.toHaveBeenCalled();
	});

	it('502s when the upstream store errors', async () => {
		const { db, platform } = makeDb();
		const row = await db
			.insert(images)
			.values({ title: 'ref', slug: 'ref', imageUrl: 'https://cdn.x/ref.png', artistId: 1, createdAt: '2026-01-01' })
			.returning({ id: images.id })
			.get();
		const fetchMock = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;

		expect(await statusOf(() => GET(makeEvent(platform, `?id=${row.id}`, fetchMock)))).toBe(502);
	});
});
