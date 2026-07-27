import { describe, it, expect } from 'vitest';
import { bufferStream, MaxBytesExceededError } from './buffer';

/** A ReadableStream emitting `count` chunks of `chunk` bytes each. */
function streamOf(chunk: Uint8Array, count: number): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= count) {
				controller.close();
				return;
			}
			controller.enqueue(chunk);
			sent++;
		}
	});
}

describe('bufferStream', () => {
	it('buffers an under-cap stream into the concatenated bytes', async () => {
		const chunk = new Uint8Array([1, 2, 3, 4]);
		const out = await bufferStream(streamOf(chunk, 3), 100);
		expect(out.length).toBe(12);
		expect(Array.from(out.slice(0, 4))).toEqual([1, 2, 3, 4]);
	});

	it('throws MaxBytesExceededError once the cap is exceeded', async () => {
		const chunk = new Uint8Array(1024); // 1 KiB chunks
		await expect(bufferStream(streamOf(chunk, 20), 4096)).rejects.toBeInstanceOf(MaxBytesExceededError);
	});

	it('allows a stream exactly at the cap', async () => {
		const chunk = new Uint8Array(1000);
		const out = await bufferStream(streamOf(chunk, 4), 4000);
		expect(out.length).toBe(4000);
	});
});
