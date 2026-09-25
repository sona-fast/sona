import { describe, it, expect, vi, afterEach } from 'vitest';
import type { R2Bucket } from '@cloudflare/workers-types';
import { countingSource, drainTracking, FakeFixedLengthStream } from '$lib/server/test/streams';
import { R2Storage } from './r2';
import { MAX_BUFFER_BYTES, MaxBytesExceededError } from './buffer';

const MiB = 1024 * 1024;
// One MiB-chunk past the buffer cap — derived, so a cap change can't strand it.
const OVER_CAP_CHUNKS = Math.ceil(MAX_BUFFER_BYTES / MiB) + 1;

function makeStorage(put: (key: string, value: unknown, opts?: unknown) => Promise<unknown>) {
	const bucket = {
		put: vi.fn(put),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({
			objects: [] as { key: string; uploaded: Date }[],
			truncated: false
		}))
	};
	const storage = new R2Storage({
		bucket: bucket as unknown as R2Bucket,
		publicBase: 'https://cdn.example.com'
	});
	return { bucket, storage };
}

/**
 * A bucket that stores into a Map and behaves like R2 against a
 * FixedLengthStream body: its put reads until it holds `declared` bytes, then
 * commits and resolves, the way workerd's readable ends at exactly byteLength.
 * It keeps draining afterwards, so an over-length source's extra bytes still
 * reach the FixedLengthStream and fail the pump: the commit-then-reject race.
 */
function committingBucket(declared: number) {
	const stored = new Map<string, Uint8Array>();
	const bucket = {
		put: async (key: string, value: ReadableStream<Uint8Array>) => {
			const reader = value.getReader();
			const committed = new Uint8Array(declared);
			let got = 0;
			while (got < declared) {
				const { done, value: chunk } = await reader.read();
				if (done) throw new Error('put: body ended early');
				const take = Math.min(chunk.length, declared - got);
				committed.set(chunk.subarray(0, take), got);
				got += take;
			}
			stored.set(key, committed);
			void (async () => {
				for (;;) if ((await reader.read()).done) return;
			})().catch(() => {});
			return {};
		}
	};
	const storage = new R2Storage({
		bucket: bucket as unknown as R2Bucket,
		publicBase: 'https://cdn.example.com'
	});
	return { stored, storage };
}

describe('R2 streaming put', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('streams a body larger than MAX_BUFFER_BYTES through FixedLengthStream', async () => {
		vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
		const chunkSize = MiB;
		const chunks = OVER_CAP_CHUNKS;
		const size = chunks * chunkSize;
		expect(size).toBeGreaterThan(MAX_BUFFER_BYTES);

		const { stream, state } = countingSource(chunks, chunkSize);
		let received: unknown;
		let drained = 0;
		let maxOutstanding = 0;
		const { bucket, storage } = makeStorage(async (_key, value) => {
			received = value;
			({ bytes: drained, maxOutstanding } = await drainTracking(
				value as ReadableStream<Uint8Array>,
				state,
				chunkSize
			));
		});

		const { url } = await storage.put({
			suggestedKey: 'models/big.vrm',
			body: stream,
			size,
			contentType: 'application/octet-stream',
			filename: 'big.vrm'
		});

		expect(bucket.put).toHaveBeenCalledTimes(1);
		expect(received).toBeInstanceOf(ReadableStream);
		expect(drained).toBe(size);
		// The source is pulled in lockstep with the bucket's read — never
		// materialized. (TransformStream keeps a chunk or two in flight.)
		expect(maxOutstanding).toBeLessThanOrEqual(4);
		// Stored images are immutable: the put must carry the type and the 1-day
		// cache policy, or R2 serves application/octet-stream on the 4h default.
		expect(bucket.put.mock.calls[0][2]).toEqual({
			httpMetadata: {
				contentType: 'application/octet-stream',
				cacheControl: 'public, max-age=86400'
			}
		});
		expect(url).toBe('https://cdn.example.com/models/big.vrm');
	});

	it('rejects the put when the source stream errors mid-body, without deleting the key', async () => {
		vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
		const boom = new Error('source died mid-body');
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array(8));
				c.error(boom);
			}
		});
		const { bucket, storage } = makeStorage(async (_key, value) => {
			// Drain like the real bucket; swallow the readable's error — the pump's
			// rejection is the one the Promise.all([put, pump]) contract guards.
			await new Response(value as ReadableStream).arrayBuffer().catch(() => {});
		});
		await expect(
			storage.put({
				suggestedKey: 'a/b.png',
				body: stream,
				size: 16,
				contentType: 'image/png',
				filename: 'b.png'
			})
		).rejects.toThrow('source died mid-body');
		// An errored source leaves the key absent — nothing to clean up. The
		// assertion guards the real hazard: a cleanup delete could destroy a
		// pre-existing live object at the same key.
		expect(bucket.delete).not.toHaveBeenCalled();
	});

	it('an over-length source never lets the store commit a truncated object', async () => {
		vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
		const { stored, storage } = committingBucket(8);
		const { stream } = countingSource(2, 8); // 16 bytes actual
		await expect(
			storage.put({
				suggestedKey: 'a/over.png',
				body: stream,
				size: 8, // the first chunk alone completes the declared size
				contentType: 'image/png',
				filename: 'over.png'
			})
		).rejects.toThrow(/too many bytes/);
		expect(stored.has('a/over.png')).toBe(false);
	});

	it('an over-length put leaves an existing object at the key untouched', async () => {
		vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
		const { stored, storage } = committingBucket(8);
		const previous = new Uint8Array([1, 2, 3]);
		stored.set('a/over.png', previous);
		// The overrun arrives in a later chunk than the one completing the size.
		const { stream } = countingSource(3, 4); // 12 bytes actual
		await expect(
			storage.put({
				suggestedKey: 'a/over.png',
				body: stream,
				size: 8,
				contentType: 'image/png',
				filename: 'over.png'
			})
		).rejects.toThrow(/too many bytes/);
		expect(stored.get('a/over.png')).toBe(previous);
	});

	it('an empty chunk does not release the chunk that completes the size', async () => {
		vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
		const { stored, storage } = committingBucket(8);
		const sizes = [4, 4, 0, 4]; // 12 bytes actual; the empty chunk sits at the boundary
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				const n = sizes.shift();
				if (n === undefined) c.close();
				else c.enqueue(new Uint8Array(n));
			}
		});
		await expect(
			storage.put({
				suggestedKey: 'a/over.png',
				body: stream,
				size: 8,
				contentType: 'image/png',
				filename: 'over.png'
			})
		).rejects.toThrow(/too many bytes/);
		expect(stored.has('a/over.png')).toBe(false);
	});

	it('an exact-length source still commits every byte through the hold-back', async () => {
		vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
		const { stored, storage } = committingBucket(12);
		const expected = Uint8Array.from({ length: 12 }, (_, n) => 0x10 * n + n);
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(expected.slice(0, 4));
				c.enqueue(expected.slice(4, 8));
				c.enqueue(expected.slice(8));
				c.close();
			}
		});
		await storage.put({
			suggestedKey: 'a/exact.png',
			body: stream,
			size: 12,
			contentType: 'image/png',
			filename: 'exact.png'
		});
		expect(stored.get('a/exact.png')).toEqual(expected);
	});

	it('a source that errors before the store commits leaves an existing object in place', async () => {
		vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
		const { stored, storage } = committingBucket(16);
		const previous = new Uint8Array([9, 9, 9]);
		stored.set('a/keep.png', previous);
		// The full 16 bytes arrive first and the source errors on the NEXT pull.
		// Erroring in the same tick would drop the queued chunk before the store
		// saw it, so the test would pass with or without the hold-back.
		let emitted = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				if (emitted) {
					c.error(new Error('source died mid-body'));
					return;
				}
				emitted = true;
				c.enqueue(new Uint8Array(16));
			}
		});
		await expect(
			storage.put({
				suggestedKey: 'a/keep.png',
				body: stream,
				size: 16,
				contentType: 'image/png',
				filename: 'keep.png'
			})
		).rejects.toThrow('source died mid-body');
		// The put never committed, so the cleanup must not touch the key.
		expect(stored.get('a/keep.png')).toBe(previous);
	});

	it('round-trips: a URL returned by the streaming put survives an orphan sweep', async () => {
		vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
		const { stream } = countingSource(2, 8);
		const { bucket, storage } = makeStorage(async (_key, value) => {
			await new Response(value as ReadableStream).arrayBuffer();
		});
		const { url } = await storage.put({
			suggestedKey: 'artwork/pic.png',
			body: stream,
			size: 16,
			contentType: 'image/png',
			filename: 'pic.png'
		});
		// The bucket now lists exactly the uploaded key; sweeping with the stored
		// URL as the reference set must keep it.
		bucket.list.mockResolvedValue({
			objects: [{ key: 'artwork/pic.png', uploaded: new Date() }],
			truncated: false
		});
		const deleted = await storage.deleteOrphans([url]);
		expect(deleted).toBe(0);
		expect(bucket.delete).not.toHaveBeenCalled();
	});

	it('without FixedLengthStream (Node dev/tests) buffers up to the declared size', async () => {
		const { stream } = countingSource(4, 8); // 32 bytes
		let received: unknown;
		const { bucket, storage } = makeStorage(async (_key, value) => {
			received = value;
		});
		await storage.put({
			suggestedKey: 'a/b.png',
			body: stream,
			size: 32,
			contentType: 'image/png',
			filename: 'b.png'
		});
		expect(received).toBeInstanceOf(Uint8Array);
		expect((received as Uint8Array).length).toBe(32);
		// The buffered branch must carry the same metadata as the streaming one.
		expect(bucket.put.mock.calls[0][2]).toEqual({
			httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=86400' }
		});
	});

	it('without FixedLengthStream, a body that overruns its declared size fails', async () => {
		const { stream } = countingSource(4, 8); // 32 bytes actual
		const { bucket, storage } = makeStorage(async () => {});
		await expect(
			storage.put({
				suggestedKey: 'a/b.png',
				body: stream,
				size: 16, // lies: declares fewer bytes than the stream holds
				contentType: 'image/png',
				filename: 'b.png'
			})
		).rejects.toBeInstanceOf(MaxBytesExceededError);
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('without FixedLengthStream, a body that undershoots its declared size fails', async () => {
		const { stream } = countingSource(2, 8); // 16 bytes actual
		const { bucket, storage } = makeStorage(async () => {});
		await expect(
			storage.put({
				suggestedKey: 'a/b.png',
				body: stream,
				size: 32,
				contentType: 'image/png',
				filename: 'b.png'
			})
		).rejects.toThrow(/16 bytes but 32 were declared/);
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('a stream without a size keeps the MAX_BUFFER_BYTES guard', async () => {
		const { stream } = countingSource(OVER_CAP_CHUNKS, MiB);
		const { bucket, storage } = makeStorage(async () => {});
		await expect(
			storage.put({
				suggestedKey: 'a/huge.bin',
				body: stream,
				contentType: 'application/octet-stream',
				filename: 'huge.bin'
			})
		).rejects.toBeInstanceOf(MaxBytesExceededError);
		expect(bucket.put).not.toHaveBeenCalled();
	});
});
