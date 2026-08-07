import { describe, it, expect, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { makeD1 } from '$lib/server/test/d1';
import { PNG_MAGIC } from '$lib/server/test/raster-fixtures';
import { migrateImages } from './migrate';
import type { StorageProvider } from './types';

function makeDb() {
	const sqlite = new Database(':memory:');
	sqlite.exec(
		'CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, slug TEXT, image_url TEXT, thumbnail_url TEXT)'
	);
	return { sqlite, db: drizzle(makeD1(sqlite), { schema }) };
}

function fakeTarget(
	putImpl: StorageProvider['put']
): StorageProvider & { put: ReturnType<typeof vi.fn> } {
	return {
		id: 'r2',
		put: vi.fn(putImpl),
		deleteByUrl: vi.fn(async () => {}),
		owns: () => false,
		deleteOrphans: vi.fn(async () => 0)
	} as unknown as StorageProvider & { put: ReturnType<typeof vi.fn> };
}

/** `total` bytes that sniff as a PNG (magic head, zero padding). */
function pngBytes(total: number): Uint8Array {
	const bytes = new Uint8Array(total);
	bytes.set(PNG_MAGIC);
	return bytes;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(c) {
			for (const chunk of chunks) c.enqueue(chunk);
			c.close();
		}
	});
}

describe('migrate copyOne streaming', () => {
	it('passes the source stream and its Content-Length through to the target put', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'pic', 'https://old.example/f/abc');

		const bytes = pngBytes(64 * 1024);
		const fetchFn = vi.fn(
			async () =>
				new Response(streamOf(bytes), {
					headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) }
				})
		) as unknown as typeof fetch;

		const target = fakeTarget(async ({ body, size }) => {
			expect(body).toBeInstanceOf(ReadableStream);
			expect(size).toBe(bytes.length);
			// Drain like a real provider would — the sniffed head was re-prepended,
			// so the full body must round-trip byte-identical.
			const drained = new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
			expect(drained).toEqual(bytes);
			return { url: 'https://cdn.example.com/artwork/pic.png' };
		});

		const result = await migrateImages({ db, fetchFn, target });
		expect(result.migrated).toBe(1);
		expect(result.failed).toBe(0);
		expect(target.put).toHaveBeenCalledTimes(1);
		const row = sqlite.prepare('SELECT image_url FROM images').get() as { image_url: string };
		expect(row.image_url).toBe('https://cdn.example.com/artwork/pic.png');
	});

	it('re-prepends a sniff head that arrived in tiny chunks', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'chunky', 'https://old.example/f/chunky');

		// The 64-byte sniff spans several small chunks; all of them (and the
		// rest) must reach the provider in order.
		const bytes = pngBytes(256);
		const chunks = [bytes.slice(0, 5), bytes.slice(5, 40), bytes.slice(40, 100), bytes.slice(100)];
		const fetchFn = vi.fn(
			async () =>
				new Response(streamOf(...chunks), {
					headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) }
				})
		) as unknown as typeof fetch;

		const target = fakeTarget(async ({ body }) => {
			const drained = new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
			expect(drained).toEqual(bytes);
			return { url: 'https://cdn.example.com/artwork/chunky.png' };
		});

		const result = await migrateImages({ db, fetchFn, target });
		expect(result.migrated).toBe(1);
		expect(result.failed).toBe(0);
	});

	it('falls back to a buffered body when the source response has no Content-Length', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'pic2', 'https://old.example/f/def');

		const bytes = pngBytes(1024);
		const fetchFn = vi.fn(async () => {
			const res = new Response(streamOf(bytes), { headers: { 'content-type': 'image/png' } });
			// Response infers no length from a stream body; make the absence explicit.
			res.headers.delete('content-length');
			return res;
		}) as unknown as typeof fetch;

		const target = fakeTarget(async ({ body, size }) => {
			expect(body).toBeInstanceOf(Uint8Array);
			expect(size).toBeUndefined();
			return { url: 'https://cdn.example.com/artwork/pic2.png' };
		});

		const result = await migrateImages({ db, fetchFn, target });
		expect(result.migrated).toBe(1);
		expect(result.failed).toBe(0);
	});

	it('falls back to a buffered body when the source response is content-encoded', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'pic3', 'https://old.example/f/ghi');

		// A compressed response's Content-Length counts COMPRESSED bytes while
		// res.body yields decoded ones — streaming with that size would fail the
		// providers' length checks and brick this image's migration. Simulate the
		// mismatch: declared 512, decoded body 1024.
		const bytes = pngBytes(1024);
		const fetchFn = vi.fn(
			async () =>
				new Response(streamOf(bytes), {
					headers: {
						'content-type': 'image/png',
						'content-length': '512',
						'content-encoding': 'gzip'
					}
				})
		) as unknown as typeof fetch;

		const target = fakeTarget(async ({ body, size }) => {
			expect(body).toBeInstanceOf(Uint8Array);
			expect((body as Uint8Array).length).toBe(bytes.length);
			expect(size).toBeUndefined();
			return { url: 'https://cdn.example.com/artwork/pic3.png' };
		});

		const result = await migrateImages({ db, fetchFn, target });
		expect(result.migrated).toBe(1);
		expect(result.failed).toBe(0);
	});
});

describe('migrate copyOne content sniffing (SONA-141)', () => {
	it('fails the row when the source bytes are not an allowed raster image', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'evil', 'https://old.example/f/evil');

		// The header LIES (image/png) but the bytes are HTML — re-hosting them
		// onto the CDN origin would serve active content. The row must fail and
		// stay pending, and the provider must never see the bytes.
		const html = new TextEncoder().encode('<html><script>alert(1)</script></html>'.padEnd(128, ' '));
		// The body arrives in two chunks so the source is still mid-stream when
		// the sniff rejects — the reader must be cancelled, not abandoned locked.
		const cancelled = vi.fn();
		const fetchFn = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(html.slice(0, 100));
							c.enqueue(html.slice(100));
						},
						cancel: cancelled
					}),
					{ headers: { 'content-type': 'image/png', 'content-length': String(html.length) } }
				)
		) as unknown as typeof fetch;

		const target = fakeTarget(async () => ({ url: 'https://cdn.example.com/never.png' }));

		const result = await migrateImages({ db, fetchFn, target });
		expect(result.migrated).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.items[0]).toMatchObject({ status: 'failed' });
		expect(result.items[0].error).toMatch(/not an allowed raster image/);
		expect(target.put).not.toHaveBeenCalled();
		// The source stream was released, not left locked and undrained.
		expect(cancelled).toHaveBeenCalled();
		// The DB still points at the old URL — nothing was repointed.
		const row = sqlite.prepare('SELECT image_url FROM images').get() as { image_url: string };
		expect(row.image_url).toBe('https://old.example/f/evil');
	});

	it('stores the SNIFFED type when the source header is generic', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'honest', 'https://old.example/f/honest');

		// Honest PNG bytes under application/octet-stream: the row must migrate,
		// with the corrected type and extension derived from the BYTES.
		const bytes = pngBytes(512);
		const fetchFn = vi.fn(
			async () =>
				new Response(streamOf(bytes), {
					headers: {
						'content-type': 'application/octet-stream',
						'content-length': String(bytes.length)
					}
				})
		) as unknown as typeof fetch;

		const target = fakeTarget(async ({ suggestedKey, contentType, body }) => {
			expect(contentType).toBe('image/png');
			expect(suggestedKey).toBe('artwork/honest.png');
			await new Response(body as ReadableStream).arrayBuffer();
			return { url: 'https://cdn.example.com/artwork/honest.png' };
		});

		const result = await migrateImages({ db, fetchFn, target });
		expect(result.migrated).toBe(1);
		expect(result.failed).toBe(0);
	});
});
