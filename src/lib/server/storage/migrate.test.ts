import { describe, it, expect, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { makeD1 } from '$lib/server/test/d1';
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

describe('migrate copyOne streaming', () => {
	it('passes the source stream and its Content-Length through to the target put', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'pic', 'https://old.example/f/abc');

		const bytes = new Uint8Array(64 * 1024);
		const fetchFn = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(bytes);
							c.close();
						}
					}),
					{ headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) } }
				)
		) as unknown as typeof fetch;

		const target = fakeTarget(async ({ body, size }) => {
			expect(body).toBeInstanceOf(ReadableStream);
			expect(size).toBe(bytes.length);
			// Drain like a real provider would.
			await new Response(body as ReadableStream).arrayBuffer();
			return { url: 'https://cdn.example.com/artwork/pic.png' };
		});

		const result = await migrateImages({ db, fetchFn, target });
		expect(result.migrated).toBe(1);
		expect(result.failed).toBe(0);
		expect(target.put).toHaveBeenCalledTimes(1);
		const row = sqlite.prepare('SELECT image_url FROM images').get() as { image_url: string };
		expect(row.image_url).toBe('https://cdn.example.com/artwork/pic.png');
	});

	it('falls back to a buffered body when the source response has no Content-Length', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'pic2', 'https://old.example/f/def');

		const bytes = new Uint8Array(1024);
		const fetchFn = vi.fn(async () => {
			const res = new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(bytes);
						c.close();
					}
				}),
				{ headers: { 'content-type': 'image/png' } }
			);
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
		const bytes = new Uint8Array(1024);
		const fetchFn = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							c.enqueue(bytes);
							c.close();
						}
					}),
					{
						headers: {
							'content-type': 'image/png',
							'content-length': '512',
							'content-encoding': 'gzip'
						}
					}
				)
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
