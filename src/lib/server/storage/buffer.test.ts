import { afterEach, describe, it, expect, vi } from 'vitest';
import { bufferStream, idleTimeout, MaxBytesExceededError } from './buffer';

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

describe('idleTimeout', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** `count` one-byte chunks, each `gapMs` after the last; never ends if `stall`. */
	function drip(count: number, gapMs: number, stall = false): ReadableStream<Uint8Array> {
		let sent = 0;
		return new ReadableStream({
			async pull(c) {
				if (sent >= count) {
					if (stall) await new Promise(() => {});
					else c.close();
					return;
				}
				await new Promise((r) => setTimeout(r, gapMs));
				sent++;
				c.enqueue(new Uint8Array([sent]));
			}
		});
	}

	it('aborts its signal with the reason when nothing arrives at all', async () => {
		vi.useFakeTimers();
		const idle = idleTimeout(1_000, () => new Error('quiet'));
		await vi.advanceTimersByTimeAsync(999);
		expect(idle.signal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		expect(idle.signal.aborted).toBe(true);
		expect((idle.signal.reason as Error).message).toBe('quiet');
	});

	it('lets a source that keeps sending run well past the timeout in total', async () => {
		vi.useFakeTimers();
		const idle = idleTimeout(1_000, () => new Error('quiet'));
		const out = bufferStream(idle.watch(drip(10, 900)));
		await vi.advanceTimersByTimeAsync(20_000);
		expect(Array.from(await out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(idle.signal.aborted).toBe(false);
		idle.clear();
	});

	it('errors the watched body with the reason once the source goes quiet', async () => {
		vi.useFakeTimers();
		const idle = idleTimeout(1_000, () => new Error('quiet'));
		const out = bufferStream(idle.watch(drip(3, 100, true)));
		const settled = expect(out).rejects.toThrow('quiet');
		await vi.advanceTimersByTimeAsync(5_000);
		await settled;
		expect(idle.signal.aborted).toBe(true);
	});

	it('does not count a slow consumer against the source', async () => {
		vi.useFakeTimers();
		const idle = idleTimeout(1_000, () => new Error('quiet'));
		const reader = idle.watch(drip(2, 10)).getReader();
		const first = reader.read();
		await vi.advanceTimersByTimeAsync(20);
		expect((await first).value).toEqual(new Uint8Array([1]));
		// The consumer sits on its hands far longer than the timeout.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(idle.signal.aborted).toBe(false);
		const second = reader.read();
		await vi.advanceTimersByTimeAsync(20);
		expect((await second).value).toEqual(new Uint8Array([2]));
		idle.clear();
	});
});
