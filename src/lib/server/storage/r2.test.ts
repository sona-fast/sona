import { describe, it, expect, vi, afterEach } from 'vitest';
import type { R2Bucket } from '@cloudflare/workers-types';
import { countingSource, drainTracking, FakeFixedLengthStream } from '$lib/server/test/streams';
import { R2Storage } from './r2';
import { MAX_BUFFER_BYTES, MaxBytesExceededError } from './buffer';

const MiB = 1024 * 1024;

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

describe('R2 streaming put', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('streams a body larger than MAX_BUFFER_BYTES through FixedLengthStream', async () => {
		vi.stubGlobal('FixedLengthStream', FakeFixedLengthStream);
		const chunkSize = MiB;
		const chunks = 11; // 11 MiB — the old buffered path threw at 10 MiB
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
		// R2 puts are atomic — a failed streamed put commits nothing, so no
		// truncated object exists and no cleanup delete may run: it could only
		// destroy a PRE-EXISTING object at the same key.
		expect(bucket.delete).not.toHaveBeenCalled();
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
		const { stream } = countingSource(11, MiB);
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
