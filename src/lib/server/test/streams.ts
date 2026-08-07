// Stream builders shared by the storage test suites. Test-only.

/**
 * Minimal stand-in for workerd's FixedLengthStream: an identity transform that
 * records the declared length (the length *enforcement* is workerd's job; the
 * suites only assert the providers route through it instead of buffering).
 */
export class FakeFixedLengthStream {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	constructor(public byteLength: number) {
		const t = new TransformStream<Uint8Array, Uint8Array>();
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
