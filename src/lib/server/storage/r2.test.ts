import { describe, it, expect, vi, afterEach } from 'vitest';
import type { R2Bucket } from '@cloudflare/workers-types';
import { R2Storage } from './r2';
import { MAX_BUFFER_BYTES, MaxBytesExceededError } from './buffer';

const MiB = 1024 * 1024;

/** Minimal stand-in for workerd's FixedLengthStream: an identity transform that
 * records the declared length (the length *enforcement* is workerd's job; these
 * tests only assert we route through it instead of buffering). */
class FakeFixedLengthStream {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	constructor(public byteLength: number) {
		const t = new TransformStream<Uint8Array, Uint8Array>();
		this.readable = t.readable;
		this.writable = t.writable;
	}
}

/** Pull-based source producing `chunks` × `chunkSize` bytes, counting pulls. */
function countingSource(chunks: number, chunkSize: number) {
	const state = { produced: 0 };
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (state.produced === chunks) {
				controller.close();
				return;
			}
			state.produced++;
			controller.enqueue(new Uint8Array(chunkSize));
		}
	});
	return { stream, state };
}

function makeStorage(put: (key: string, value: unknown, opts?: unknown) => Promise<unknown>) {
	const bucket = { put: vi.fn(put) };
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
			const reader = (value as ReadableStream<Uint8Array>).getReader();
			for (;;) {
				const { done, value: chunk } = await reader.read();
				if (done) break;
				drained += chunk.length;
				maxOutstanding = Math.max(maxOutstanding, state.produced - Math.floor(drained / chunkSize));
			}
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
		expect(url).toBe('https://cdn.example.com/models/big.vrm');
	});

	it('without FixedLengthStream (Node dev/tests) buffers up to the declared size', async () => {
		const { stream } = countingSource(4, 8); // 32 bytes
		let received: unknown;
		const { storage } = makeStorage(async (_key, value) => {
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
