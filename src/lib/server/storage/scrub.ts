// The storage decorator that makes metadata scrubbing unavoidable (SONA-170).
//
// Placed around the provider getStorage() returns rather than at each call
// site, so /api/upload, the fursuit and sticker imports, avatar re-hosting,
// provider migration, the sticker re-key and every importer written later all
// inherit it without a line of their own. That is the whole point of the
// placement: a put that skips the scrub should not be expressible.
//
// The BYTES decide, not the declared type. A declared raster is scrubbed; so is
// anything else whose leading bytes carry a raster signature, because a caller
// can be wrong about what it is holding — the sticker import takes its content
// type from a Telegram file path, so a JPEG served under a .webm path would
// otherwise skip the scrub with its GPS intact. Sticker media that really isn't
// a raster (video/webm, the Lottie JSON of an animated sticker) and VR model
// bytes (application/octet-stream) sniff as nothing and pass through untouched.

import { isAllowedImageType } from './allowlist';
import { peekStream } from '$lib/server/peek-stream';
import { scrubImageMetadata, scrubImageMetadataStream } from './scrub-metadata';
import { sniffImageType } from './sniff';
import type { StorageProvider, PutInput, PutResult, DeleteOrphansOptions } from './types';

/** Leading bytes handed to sniffImageType — enough for an AVIF ftyp box's
 * compatible_brands, matching the scrubber's own sniff window. */
const SNIFF_BYTES = 64;

/**
 * Wrap `inner` so every stored raster goes through the metadata scrubber.
 * Delegates everything except put() unchanged.
 */
export function withMetadataScrubbing(inner: StorageProvider): StorageProvider {
	return new ScrubbingStorage(inner);
}

class ScrubbingStorage implements StorageProvider {
	#inner: StorageProvider;

	constructor(inner: StorageProvider) {
		this.#inner = inner;
	}

	get id() {
		return this.#inner.id;
	}

	async put(input: PutInput): Promise<PutResult> {
		const declared = isAllowedImageType(input.contentType);
		const { body } = input;
		if (body instanceof ReadableStream) {
			// `size` is unchanged on purpose: the scrub is size-preserving, so the
			// provider's length declaration (R2's FixedLengthStream, UploadThing's
			// presigned ingest) still holds. A throw inside the transform errors
			// the piped stream, which rejects the provider's put rather than
			// leaving it waiting on bytes that will never come.
			if (declared) {
				return this.#inner.put({ ...input, body: body.pipeThrough(scrubImageMetadataStream()) });
			}
			// peekStream replays the head rather than buffering the file, so a model
			// upload still streams end to end — it just gets sniffed on the way past.
			const { head, stream } = await peekStream(body, SNIFF_BYTES);
			if (!sniffImageType(head)) return this.#inner.put({ ...input, body: stream });
			return this.#inner.put({ ...input, body: stream.pipeThrough(scrubImageMetadataStream()) });
		}
		const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
		if (!declared && !sniffImageType(bytes.subarray(0, SNIFF_BYTES))) return this.#inner.put(input);
		return this.#inner.put({ ...input, body: scrubImageMetadata(bytes) });
	}

	deleteByUrl(url: string): Promise<void> {
		return this.#inner.deleteByUrl(url);
	}

	owns(url: string): boolean {
		return this.#inner.owns(url);
	}

	deleteOrphans(referencedUrls: string[], opts?: DeleteOrphansOptions): Promise<number> {
		return this.#inner.deleteOrphans(referencedUrls, opts);
	}
}
