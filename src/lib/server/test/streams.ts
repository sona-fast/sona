// Stream builders shared by the storage test suites. Test-only.

/**
 * Minimal stand-in for workerd's FixedLengthStream: an identity transform that
 * records the declared length and fails the way workerd does — the writable
 * errors when writes exceed byteLength, and errors on close before byteLength.
 * Consumer-abort semantics (a reader cancelling the readable side) remain
 * unmodelled.
 */
export class FakeFixedLengthStream {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	constructor(public byteLength: number) {
		let written = 0;
		const t = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, c) {
				written += chunk.length;
				if (written > byteLength) {
					throw new TypeError(
						`FakeFixedLengthStream: wrote ${written} bytes but expected ${byteLength}`
					);
				}
				c.enqueue(chunk);
			},
			flush() {
				if (written < byteLength) {
					throw new TypeError(
						`FakeFixedLengthStream: closed after ${written} bytes but expected ${byteLength}`
					);
				}
			}
		});
		this.readable = t.readable;
		this.writable = t.writable;
	}
}

/**
 * A pull-based source of `chunks` chunks of `chunkSize` bytes that counts how
 * many have been handed out — the probe for "consumed incrementally": if a
 * consumer buffered the stream, every chunk would be produced before the first
 * downstream read.
 */
export function countingSource(chunks: number, chunkSize: number) {
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

/**
 * Drain `stream` chunk by chunk, tracking how far ahead a countingSource's
 * production ran of the consumption — the other half of the "consumed
 * incrementally" probe. A producer that buffered would show every chunk
 * outstanding before the first read.
 */
export async function drainTracking(
	stream: ReadableStream<Uint8Array>,
	state: { produced: number },
	chunkSize: number
): Promise<{ bytes: number; maxOutstanding: number }> {
	let bytes = 0;
	let maxOutstanding = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.length;
		maxOutstanding = Math.max(maxOutstanding, state.produced - Math.floor(bytes / chunkSize));
	}
	return { bytes, maxOutstanding };
}
