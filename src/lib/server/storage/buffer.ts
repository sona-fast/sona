// Bounded in-memory buffering for stored media (finding M8).
//
// Workers have a hard memory ceiling, so buffering a whole upload/download body
// into an ArrayBuffer with no cap lets a large (admin-gated) source OOM the
// isolate. Mirror the .tgs gunzip cap (sticker-import.ts): read chunk-by-chunk
// and abort the moment the total exceeds the cap, rather than fully buffering
// first and checking the size after.

import { MAX_BUFFER_BYTES } from '$lib/config';

/** The 64 MB buffered-upload cap — the full memory rationale lives with the
 * value in $lib/config (client-safe: the admin media picker pre-checks it);
 * this re-export keeps the server call sites unchanged. */
export { MAX_BUFFER_BYTES };

/**
 * 10 MiB: the cap for REMOTE bodies we buffer (Telegram file downloads,
 * FurTrack photo imports). Deliberately decoupled from — and far below — the
 * 64 MiB local upload cap: nothing legitimate from those sources comes near it
 * (Telegram's getFile tops out ~20 MB and stickers are ~512 KB; FurTrack
 * photos are a few MB), and a hostile or misbehaving remote origin shouldn't
 * get to fill isolate memory the way a trusted admin upload may.
 */
export const MAX_REMOTE_BUFFER_BYTES = 10 * 1024 * 1024;

/** Thrown when a buffered body exceeds the byte cap. */
export class MaxBytesExceededError extends Error {
	constructor(public readonly max: number) {
		super(`stream exceeds ${max}-byte buffer cap`);
		this.name = 'MaxBytesExceededError';
	}
}

/**
 * Buffer a ReadableStream into a single Uint8Array, throwing
 * MaxBytesExceededError as soon as more than `max` bytes have arrived (the
 * stream is cancelled on overflow so nothing keeps flowing).
 *
 * The array is allocated here, so its buffer is a plain ArrayBuffer rather than
 * the ArrayBufferLike the default type parameter allows. Said out loud because
 * a BlobPart will not accept the loose form, and a caller handing the view
 * straight to a Blob should not need a cast to do it.
 */
export async function bufferStream(
	body: ReadableStream<Uint8Array>,
	max = MAX_BUFFER_BYTES
): Promise<Uint8Array<ArrayBuffer>> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > max) {
			await reader.cancel();
			throw new MaxBytesExceededError(max);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/**
 * A timeout on a source going quiet, not on how long it takes overall. The
 * timer starts at once (covering the wait for headers), and `watch` re-arms it
 * on every read of the body, so a slow source that keeps sending finishes
 * while one that stops sending fails. It only runs while waiting on the
 * source: a slow consumer between reads never trips it. The watched body has
 * a high-water mark of 0, so it reads the source only when the consumer asks;
 * the default of 1 would read ahead and arm the timer while the consumer
 * pauses.
 *
 * When it fires, `signal` aborts with `reason()` and a watched body errors
 * with that same reason, so the caller sees one message whichever wait it hit.
 * Call `clear` once the copy is done.
 */
export function idleTimeout(
	ms: number,
	reason: () => Error
): {
	signal: AbortSignal;
	watch(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
	clear(): void;
} {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(reason()), ms);
	};
	const clear = () => clearTimeout(timer);
	// One read of `reader`, rejected with the reason if the signal aborts first.
	// The abort listener lives only as long as the read, so a long copy doesn't
	// pile up a reaction per chunk.
	const readOrAbort = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
		const signal = controller.signal;
		let onAbort = () => {};
		return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			onAbort = () => reject(signal.reason);
			signal.addEventListener('abort', onAbort, { once: true });
			reader.read().then(resolve, reject);
		}).finally(() => signal.removeEventListener('abort', onAbort));
	};
	arm();
	return {
		signal: controller.signal,
		clear,
		watch(body) {
			const reader = body.getReader();
			return new ReadableStream<Uint8Array>({
				async pull(c) {
					arm();
					let chunk: ReadableStreamReadResult<Uint8Array>;
					try {
						chunk = await readOrAbort(reader);
					} catch (e) {
						await reader.cancel(e).catch(() => {});
						throw e;
					}
					clear();
					if (chunk.done) c.close();
					else c.enqueue(chunk.value);
				},
				cancel(r) {
					clear();
					return reader.cancel(r);
				}
			}, { highWaterMark: 0 });
		}
	};
}
