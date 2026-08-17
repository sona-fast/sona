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
