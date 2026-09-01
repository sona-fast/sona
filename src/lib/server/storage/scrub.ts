// The storage decorator that makes metadata scrubbing unavoidable (SONA-170).
//
// Placed around the provider getStorage() returns rather than at each call
// site, so /api/upload, the fursuit and sticker imports, avatar re-hosting,
// provider migration, the sticker re-key and every importer written later all
// inherit it without a line of their own. That is the whole point of the
// placement: a put that skips the scrub should not be expressible.
//
// Only bodies whose DECLARED content type is a raster we serve publicly are
// scrubbed. Sticker media that isn't a raster (video/webm, the Lottie JSON of
// an animated Telegram sticker) and VR model bytes (application/octet-stream)
// pass through untouched — there is no raster metadata in them to strip, and
// the scrubber would reject them for having no raster signature.

import { isAllowedImageType } from './index';
import { scrubImageMetadata, scrubImageMetadataStream } from './scrub-metadata';
import type { StorageProvider, PutInput, PutResult, DeleteOrphansOptions } from './types';

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
		if (!isAllowedImageType(input.contentType)) return this.#inner.put(input);
		const { body } = input;
		if (body instanceof ReadableStream) {
			// `size` is unchanged on purpose: the scrub is size-preserving, so the
			// provider's length declaration (R2's FixedLengthStream, UploadThing's
			// presigned ingest) still holds. A throw inside the transform errors
			// the piped stream, which rejects the provider's put rather than
			// leaving it waiting on bytes that will never come.
			return this.#inner.put({ ...input, body: body.pipeThrough(scrubImageMetadataStream()) });
		}
		const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
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
