import { describe, it, expect, vi } from 'vitest';
// better-sqlite3 ships no bundled types and is a dev-only test dependency here.
// @ts-expect-error - no declaration file for 'better-sqlite3'
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '$lib/server/db/schema';
import { makeD1 } from '$lib/server/test/d1';
import { PNG_MAGIC } from '$lib/server/test/raster-fixtures';
import { MAX_BUFFER_BYTES } from './buffer';
import { migrateImages, migrateNextBatch } from './migrate';
import { UnscrubbableImageError, UNSCRUBBABLE_MIGRATE_MESSAGE } from './scrub-metadata';
import { avifFixture } from './scrub-metadata.fixtures';
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

describe('migrate copyOne bounds a misbehaving source', () => {
	it('fails the row, not the isolate, when an unsized body runs past the buffer cap', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'endless', 'https://old.example/f/endless');

		// No Content-Length, so the copy buffers. The body never ends: one PNG
		// head, then 1 MiB chunks for as long as anyone keeps reading.
		const chunk = new Uint8Array(1024 * 1024);
		let pulled = 0;
		const fetchFn = vi.fn(async () => {
			const res = new Response(
				new ReadableStream<Uint8Array>({
					pull(c) {
						c.enqueue(pulled++ === 0 ? pngBytes(1024) : chunk);
					}
				}),
				{ headers: { 'content-type': 'image/png' } }
			);
			res.headers.delete('content-length');
			return res;
		}) as unknown as typeof fetch;
		const target = fakeTarget(async () => ({ url: 'https://cdn.example.com/x.png' }));

		const result = await migrateImages({ db, fetchFn, target });

		expect(result.failed).toBe(1);
		expect(result.items[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/buffer cap/) });
		expect(target.put).not.toHaveBeenCalled();
		// It stopped reading at the cap rather than draining forever.
		expect(pulled).toBeLessThan(80);
	});

	it('fails the row when the source never answers', async () => {
		vi.useFakeTimers();
		try {
			const { sqlite, db } = makeDb();
			sqlite
				.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
				.run('t', 'silent', 'https://old.example/f/silent');

			// A host that accepts the connection and never sends headers: the fetch
			// settles only when its signal aborts, as a real fetch does, with the
			// runtime's own AbortError.
			const fetchFn = vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () =>
							reject(new DOMException('The operation was aborted.', 'AbortError'))
						);
					})
			) as unknown as typeof fetch;
			const target = fakeTarget(async () => ({ url: 'https://cdn.example.com/x.png' }));

			const pending = migrateImages({ db, fetchFn, target });
			await vi.advanceTimersByTimeAsync(60_000);
			const result = await pending;

			expect(result.failed).toBe(1);
			expect(result.migrated).toBe(0);
			// The fetch's own "The operation was aborted." says neither what happened nor where.
			expect(result.items[0].error).toMatch(/timed out.*for https:\/\/old\.example\/f\/silent$/);
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * A body that sends a PNG head, then `chunks` more 1 KiB chunks `gapMs`
	 * apart, then either closes or (`stall`) goes silent. Like a real fetch body
	 * it errors only when the request's signal aborts.
	 */
	function dripFetch(opts: { chunks: number; gapMs: number; sized: boolean; stall?: boolean }) {
		const chunk = new Uint8Array(1024);
		const total = 1024 + opts.chunks * chunk.length;
		return vi.fn(async (_url: string, init?: RequestInit) => {
			let sent = 0;
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					init?.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
				},
				async pull(c) {
					if (sent === 0) {
						sent++;
						c.enqueue(pngBytes(1024));
						return;
					}
					if (sent > opts.chunks) {
						// A stalled source: this pull never settles.
						if (opts.stall) await new Promise(() => {});
						else c.close();
						return;
					}
					await new Promise((r) => setTimeout(r, opts.gapMs));
					sent++;
					c.enqueue(chunk);
				}
			});
			const res = new Response(body, {
				headers: opts.sized
					? { 'content-type': 'image/png', 'content-length': String(total) }
					: { 'content-type': 'image/png' }
			});
			if (!opts.sized) res.headers.delete('content-length');
			return res;
		}) as unknown as typeof fetch;
	}

	/** A target that drains the body the way a real provider would. */
	function drainingTarget() {
		return fakeTarget(async ({ body }) => {
			await new Response(body as ReadableStream | Uint8Array<ArrayBuffer>).arrayBuffer();
			return { url: 'https://cdn.example.com/x.png' };
		});
	}

	it.each([
		['sized (streamed)', true],
		['unsized (buffered)', false]
	])('migrates a %s body that keeps sending, however long it takes', async (_label, sized) => {
		vi.useFakeTimers();
		try {
			const { sqlite, db } = makeDb();
			sqlite
				.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
				.run('t', 'slow', 'https://old.example/f/slow');

			// A chunk every 5s for 40s: well past the 15s idle bound in total, never
			// close to it between chunks.
			const fetchFn = dripFetch({ chunks: 8, gapMs: 5_000, sized });
			const target = drainingTarget();

			const pending = migrateImages({ db, fetchFn, target });
			await vi.advanceTimersByTimeAsync(60_000);
			const result = await pending;

			expect(result.items[0].error).toBeUndefined();
			expect(result.migrated).toBe(1);
			expect(result.failed).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['sized (streamed)', true],
		['unsized (buffered)', false]
	])('fails the row when a %s body stops sending after the headers', async (_label, sized) => {
		vi.useFakeTimers();
		try {
			const { sqlite, db } = makeDb();
			sqlite
				.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
				.run('t', 'stalled', 'https://old.example/f/stalled');

			const fetchFn = dripFetch({ chunks: 2, gapMs: 1_000, sized, stall: true });
			const target = drainingTarget();

			const pending = migrateImages({ db, fetchFn, target });
			await vi.advanceTimersByTimeAsync(60_000);
			const result = await pending;

			expect(result.migrated).toBe(0);
			expect(result.failed).toBe(1);
			expect(result.items[0].error).toMatch(/timed out.*for https:\/\/old\.example\/f\/stalled$/);
		} finally {
			vi.useRealTimers();
		}
	});

	it('cancels the source when the target fails mid-stream', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'half', 'https://old.example/f/half');

		// A sized source that sends its head and then keeps the body open.
		const cancel = vi.fn();
		const fetchFn = vi.fn(async () => {
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(pngBytes(1024));
				},
				pull: () => new Promise(() => {}),
				cancel
			});
			return new Response(body, {
				headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024) }
			});
		}) as unknown as typeof fetch;
		// The target reads the first chunk, then gives up without cancelling.
		const target = fakeTarget(async ({ body }) => {
			await (body as ReadableStream<Uint8Array>).getReader().read();
			throw new Error('target write failed');
		});

		const result = await migrateImages({ db, fetchFn, target });

		expect(result.items[0]).toMatchObject({ status: 'failed', error: 'target write failed' });
		expect(cancel).toHaveBeenCalled();
	});

	it("keeps the target's own error when it fails after the source timed out", async () => {
		vi.useFakeTimers();
		try {
			const { sqlite, db } = makeDb();
			sqlite
				.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
				.run('t', 'quota', 'https://old.example/f/quota');

			// A sized source that sends its head and then goes silent.
			const fetchFn = vi.fn(async () => {
				let sent = false;
				const body = new ReadableStream<Uint8Array>({
					async pull(c) {
						if (!sent) {
							sent = true;
							c.enqueue(pngBytes(1024));
						} else await new Promise(() => {});
					}
				});
				return new Response(body, {
					headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024) }
				});
			}) as unknown as typeof fetch;
			// The target asks for more (arming the idle timer, which fires at 15s),
			// then fails for a reason of its own after the source has timed out.
			const target = fakeTarget(async ({ body }) => {
				const reader = (body as ReadableStream<Uint8Array>).getReader();
				await reader.read();
				reader.read().catch(() => {});
				await new Promise((r) => setTimeout(r, 20_000));
				throw new Error('target quota exceeded');
			});

			const pending = migrateImages({ db, fetchFn, target });
			await vi.advanceTimersByTimeAsync(60_000);
			const result = await pending;

			expect(result.failed).toBe(1);
			expect(result.items[0].error).toBe('target quota exceeded');
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not count a pause in the target against the source', async () => {
		vi.useFakeTimers();
		try {
			const { sqlite, db } = makeDb();
			sqlite
				.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
				.run('t', 'paused', 'https://old.example/f/paused');

			// A sized source that sends its head, then holds the tail until the
			// target has finished pausing: any read ahead of the target would
			// sit on the silent source past the 15s idle bound.
			let release = () => {};
			const gate = new Promise<void>((r) => (release = r));
			const head = pngBytes(1024);
			const tail = new Uint8Array(1024);
			let sent = 0;
			const fetchFn = vi.fn(async () => {
				const body = new ReadableStream<Uint8Array>({
					async pull(c) {
						if (sent === 0) c.enqueue(head);
						else if (sent === 1) {
							await gate;
							c.enqueue(tail);
						} else c.close();
						sent++;
					}
				});
				return new Response(body, {
					headers: { 'content-type': 'image/png', 'content-length': String(head.length + tail.length) }
				});
			}) as unknown as typeof fetch;
			const target = fakeTarget(async ({ body }) => {
				const reader = (body as ReadableStream<Uint8Array>).getReader();
				await reader.read();
				await new Promise((r) => setTimeout(r, 30_000));
				release();
				while (!(await reader.read()).done);
				return { url: 'https://cdn.example.com/x.png' };
			});

			const pending = migrateImages({ db, fetchFn, target });
			await vi.advanceTimersByTimeAsync(60_000);
			const result = await pending;

			expect(result.items[0].error).toBeUndefined();
			expect(result.migrated).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('fails the row without copying when the declared length is over the buffer cap', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'huge', 'https://old.example/f/huge');

		const fetchFn = vi.fn(
			async () =>
				new Response(streamOf(pngBytes(1024)), {
					headers: { 'content-type': 'image/png', 'content-length': String(MAX_BUFFER_BYTES + 1) }
				})
		) as unknown as typeof fetch;
		const target = fakeTarget(async () => ({ url: 'https://cdn.example.com/x.png' }));

		const result = await migrateImages({ db, fetchFn, target });

		expect(result.failed).toBe(1);
		expect(result.items[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/buffer cap/) });
		expect(target.put).not.toHaveBeenCalled();
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
		// Padded past the sniff window so the rejection happens with the stream
		// still open rather than at its end.
		const html = new TextEncoder().encode('<html><script>alert(1)</script></html>'.padEnd(300, ' '));
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

	it('migrates an AVIF whose avif brand sits past byte 64 of its ftyp', async () => {
		// The sniff window is shared with the scrubber and /api/upload: a local
		// 64-byte window here read this file as no raster and failed the row a
		// fresh upload of the same bytes would have accepted.
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'long-ftyp', 'https://old.example/f/long-ftyp');
		const bytes = avifFixture({ longFtyp: true }).file;
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
			expect(contentType).toBe('image/avif');
			expect(suggestedKey).toBe('artwork/long-ftyp.avif');
			await new Response(body as ReadableStream).arrayBuffer();
			return { url: 'https://cdn.example.com/artwork/long-ftyp.avif' };
		});

		const result = await migrateImages({ db, fetchFn, target });
		expect(result.failed).toBe(0);
		expect(result.migrated).toBe(1);
	});
});

describe('migrateNextBatch failure rows', () => {
	it('tells the operator what to do when an object cannot be scrubbed', async () => {
		// An object stored before the scrubber existed (SONA-170) is refused on the
		// way into the new provider. The failures list is rendered on the migrate
		// page, so the row has to say how to fix it, not repeat the parser.
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'old', 'https://old.example/f/old');

		const bytes = pngBytes(512);
		const fetchFn = vi.fn(
			async () =>
				new Response(streamOf(bytes), {
					headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) }
				})
		) as unknown as typeof fetch;
		// The scrub decorator's refusal reaches the caller wrapped in the
		// provider's own fetch error, which is why this matches through
		// isUnscrubbable rather than on the error it caught.
		const target = fakeTarget(async () => {
			throw new Error('fetch failed', { cause: new UnscrubbableImageError('png: chunk length is impossible') });
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const progress = await migrateNextBatch({ db, fetchFn, target, batchSize: 10 });
		expect(progress.failed).toBe(1);
		expect(progress.failures[0].error).toBe(UNSCRUBBABLE_MIGRATE_MESSAGE);
		// The parser's own wording is still available, in the log: the wrapped
		// error goes there whole, refusal cause and all.
		expect(warn).toHaveBeenCalledWith(
			'storage migration: unscrubbable object',
			expect.anything(),
			expect.objectContaining({
				cause: expect.objectContaining({ message: 'png: chunk length is impossible' })
			})
		);
		warn.mockRestore();
	});

	it('keeps the underlying message for any other failure', async () => {
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'old', 'https://old.example/f/old');

		const bytes = pngBytes(512);
		const fetchFn = vi.fn(
			async () =>
				new Response(streamOf(bytes), {
					headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) }
				})
		) as unknown as typeof fetch;
		const target = fakeTarget(async () => {
			throw new Error('bucket is full');
		});

		const progress = await migrateNextBatch({ db, fetchFn, target, batchSize: 10 });
		expect(progress.failures[0].error).toBe('bucket is full');
	});

	it('maps the same refusal the same way in migrateImages', async () => {
		// The two entry points report the same failure to the same operator, so
		// they must not word it differently.
		const { sqlite, db } = makeDb();
		sqlite
			.prepare('INSERT INTO images (title, slug, image_url) VALUES (?, ?, ?)')
			.run('t', 'old', 'https://old.example/f/old');

		const bytes = pngBytes(512);
		const fetchFn = vi.fn(
			async () =>
				new Response(streamOf(bytes), {
					headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) }
				})
		) as unknown as typeof fetch;
		const target = fakeTarget(async () => {
			throw new Error('fetch failed', { cause: new UnscrubbableImageError('png: chunk length is impossible') });
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const result = await migrateImages({ db, fetchFn, target });
		expect(result.failed).toBe(1);
		expect(result.items[0].error).toBe(UNSCRUBBABLE_MIGRATE_MESSAGE);
		// The parser's own wording still reaches the log, as it does from the
		// batched entry point.
		expect(warn).toHaveBeenCalledWith(
			'storage migration: unscrubbable object',
			expect.anything(),
			expect.objectContaining({
				cause: expect.objectContaining({ message: 'png: chunk length is impossible' })
			})
		);
		warn.mockRestore();
	});
});
