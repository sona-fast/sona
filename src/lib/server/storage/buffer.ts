// Bounded in-memory buffering for stored media (finding M8).
//
// Workers have a hard memory ceiling, so buffering a whole upload/download body
// into an ArrayBuffer with no cap lets a large (admin-gated) source OOM the
// isolate. Mirror the .tgs gunzip cap (sticker-import.ts): read chunk-by-chunk
// and abort the moment the total exceeds the cap, rather than fully buffering
// first and checking the size after.

import { MAX_BUFFER_BYTES } from '$lib/config';

/** 10 MB: comfortably above any real artwork/fursuit photo or Telegram sticker
 * (Telegram caps stickers ~512 KB), while far below the isolate memory ceiling.
 * The value lives in $lib/config (client-safe — the admin media picker
 * pre-checks it); this re-export keeps the server call sites unchanged. */
export { MAX_BUFFER_BYTES };

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
 */
export async function bufferStream(
	body: ReadableStream<Uint8Array>,
	max = MAX_BUFFER_BYTES
): Promise<Uint8Array> {
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
