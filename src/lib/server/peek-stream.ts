// Peeking the head of a stream without materializing it, shared by the VR model
// upload (which sniffs a model signature) and the storage scrubbing decorator
// (which sniffs a raster signature before deciding to scrub). Lives on its own
// so storage does not have to import the VR module for it.

/** How many empty reads in a row end the peek instead of continuing it. */
const MAX_EMPTY_READS = 8;

/**
 * Thrown when the source stops producing bytes mid-peek. A plain Error on
 * purpose: the file is not the problem, so a caller mapping refusals to a 422
 * ("export a fresh copy") must not pick this up — a stalled video upload would
 * get image-editor advice. It falls to the caller's generic 500 path instead.
 */
export class StalledSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StalledSourceError';
	}
}

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
	// A source is allowed to hand back an empty chunk, which advances nothing: a
	// source that keeps handing them back would spin this loop forever. They
	// carry no bytes, so they are dropped rather than replayed, and a run of them
	// ends the peek. Giving up early is not the same as end of input, so the head
	// it gathered is short of what the caller asked for through no fault of the
	// file: refuse rather than hand a sniffer a truncated head it would misread.
	let empties = 0;
	while (len < n) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value.length === 0) {
			if (++empties >= MAX_EMPTY_READS) {
				await reader.cancel();
				throw new StalledSourceError(
					`the source stopped producing bytes after ${len} of ${n} peeked bytes`
				);
			}
			continue;
		}
		empties = 0;
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
