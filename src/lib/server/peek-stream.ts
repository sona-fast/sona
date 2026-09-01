// Peeking the head of a stream without materializing it, shared by the VR model
// upload (which sniffs a model signature) and the storage scrubbing decorator
// (which sniffs a raster signature before deciding to scrub). Lives on its own
// so storage does not have to import the VR module for it.

/**
 * Peek the first `n` bytes of a stream WITHOUT materializing the body: reads
 * whole chunks off the reader until `n` bytes (or EOF), then returns a new
 * stream that replays those chunks before handing over to the untouched
 * remainder. Memory held is at most the read chunks (typically one), never
 * the file — the storage put still streams end-to-end.
 */
export async function peekStream(
	stream: ReadableStream<Uint8Array>,
	n: number
): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let len = 0;
	while (len < n) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		len += value.length;
	}
	const head = new Uint8Array(Math.min(len, n));
	let off = 0;
	for (const c of chunks) {
		if (off >= head.length) break;
		head.set(c.subarray(0, Math.min(c.length, head.length - off)), off);
		off += c.length;
	}
	let replayIndex = 0;
	const replayed = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (replayIndex < chunks.length) {
				controller.enqueue(chunks[replayIndex++]);
				return;
			}
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
	return { head, stream: replayed };
}
