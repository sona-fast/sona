import type { R2Bucket } from '@cloudflare/workers-types';
import { ZeroKeepError } from './types';
import { bufferStream } from './buffer';
import { fixedLengthStreamCtor } from './fixed-length';
import type { StorageProvider, PutInput, PutResult, DeleteOrphansOptions } from './types';

export interface R2Options {
	/** The R2 bucket binding (platform.env.IMAGES). */
	bucket: R2Bucket;
	/**
	 * Public base URL objects are served from, no trailing slash.
	 * Prod: the bucket's custom domain (the r2PublicUrl setting, e.g. https://cdn.example.com).
	 * Dev: the local serving route ('/img'), since the custom domain only
	 * fronts the real (non-miniflare) bucket.
	 */
	publicBase: string;
}

export class R2Storage implements StorageProvider {
	readonly id = 'r2' as const;
	#bucket: R2Bucket;
	#base: string;

	constructor(opts: R2Options) {
		this.#bucket = opts.bucket;
		this.#base = opts.publicBase.replace(/\/+$/, '');
	}

	async put({ suggestedKey, body, contentType, size }: PutInput): Promise<PutResult> {
		const key = suggestedKey.replace(/^\/+/, '');
		// Stored images are immutable (content-addressed by a random-uuid key), so
		// give them an explicit 1-day cache instead of relying on Cloudflare's 4h
		// zone default. CF Image Transformations inherit this, so resized thumbnails
		// cache for a day too rather than regenerating every 4h.
		const httpMetadata = { contentType, cacheControl: 'public, max-age=86400' };

		// R2 requires a known content length. With a declared `size`, pipe the
		// stream through FixedLengthStream so nothing is materialized and a body
		// that doesn't match the declaration fails the put. The buffering branch
		// below is workerd-unreachable (FixedLengthStream always exists there):
		// it serves Node dev/tests, and for a sized stream it buffers up to the
		// caller-declared size — a lying source is caught by the length check.
		// A stream with NO size buffers under MAX_BUFFER_BYTES (M8) instead.
		const FixedLengthStream = fixedLengthStreamCtor();
		if (body instanceof ReadableStream && size !== undefined && FixedLengthStream) {
			const fixed = new FixedLengthStream(size);
			const pump = body.pipeTo(fixed.writable);
			// Await both: the put consumes the readable side, and a pump failure
			// (size mismatch, source error) must reject the call, not float.
			// Failure modes: an under-length or errored source leaves the key
			// absent, but an OVER-length source — put() still rejects — leaves a
			// truncated object of exactly the declared size at the key, replacing
			// whatever was there. No cleanup delete, deliberately: every caller
			// passes an authoritative size (File.size or a fetch-bounded
			// Content-Length), so an over-length source is unreachable today; if
			// it ever happened the leftover is an unreferenced orphan the sweep
			// reclaims (the rejection means no DB row points at it), whereas a
			// delete here could destroy a live object under migrate's
			// deterministic keys.
			// The cast bridges the DOM ReadableStream type to workers-types' (the
			// same object at runtime; only the .d.ts lineages differ).
			await Promise.all([
				this.#bucket.put(key, fixed.readable as unknown as Parameters<R2Bucket['put']>[1], {
					httpMetadata
				}),
				pump
			]);
			return { url: `${this.#base}/${key}` };
		}
		let data: ArrayBuffer | Uint8Array;
		if (body instanceof ReadableStream) {
			data = await bufferStream(body, size);
			if (size !== undefined && data.length !== size) {
				throw new Error(`r2: body was ${data.length} bytes but ${size} were declared`);
			}
		} else {
			data = body;
		}
		await this.#bucket.put(key, data, { httpMetadata });
		return { url: `${this.#base}/${key}` };
	}

	async deleteByUrl(url: string): Promise<void> {
		const key = this.#keyFromUrl(url);
		if (key) await this.#bucket.delete(key);
	}

	owns(url: string): boolean {
		// Owned == served from our own base. With a CDN configured `#base` is a full
		// origin, so this is a prefix match on the absolute URL. With `#base`
		// root-relative ('/img' — dev, or prod before a CDN URL is set) an owned URL
		// is itself root-relative. We must NOT match an ABSOLUTE URL merely because
		// its path starts with '/img/': that is a different origin, and treating it
		// as owned would let an off-origin URL pass the self-hosted gate and be
		// fetched+streamed by the public download route (SSRF).
		return url.startsWith(`${this.#base}/`);
	}

	async deleteOrphans(referencedUrls: string[], opts?: DeleteOrphansOptions): Promise<number> {
		// The keep set must be BASE-AGNOSTIC, unlike owns()/#keyFromUrl. DB URLs
		// were absolutized against whatever base was active AT UPLOAD TIME
		// (/api/upload and the sticker/fursuit imports), so matching only the
		// CURRENT base can miss every referenced object — r2PublicUrl unset
		// (serving via /img) or set/changed after uploads — and the sweep would
		// delete referenced data as "orphans". Each URL therefore ALSO
		// contributes a key derived from its pathname ('/img/<key>' → <key>,
		// else the path minus its leading slash). Over-keeping is safe by
		// design: keys are folder/uuid.ext, so a stray external URL's path can
		// only PREVENT a deletion, never cause one.
		const keep = new Set<string>();
		for (const u of referencedUrls) {
			const fromBase = this.#keyFromUrl(u);
			if (fromBase) keep.add(fromBase);
			try {
				const path = new URL(u, 'http://relative-base.invalid').pathname;
				const fromPath = path.startsWith('/img/') ? path.slice('/img/'.length) : path.replace(/^\//, '');
				if (fromPath) keep.add(fromPath);
				// Pathnames keep percent-encoding but stored keys are raw, so ALSO
				// keep the decoded variant — an encoded char in a referenced URL
				// must not orphan its object. Over-keep only: an extra key can
				// prevent a deletion, never cause one.
				const decoded = decodeURIComponent(fromPath);
				if (decoded !== fromPath) keep.add(decoded);
			} catch {
				// not URL-shaped / not decodable — contributes no (further) key
			}
		}
		if (opts?.abortOnEmptyKeepSet && keep.size === 0) {
			const probe = await this.#bucket.list({ limit: 1 });
			if (probe.objects.length) {
				throw new ZeroKeepError(
					'r2: no referenced URL resolves to a stored key — refusing to treat the whole bucket as orphans (empty or unmappable reference set?)'
				);
			}
		}
		let deleted = 0;
		let cursor: string | undefined;
		do {
			const listing = await this.#bucket.list(cursor ? { cursor, limit: 1000 } : { limit: 1000 });
			const orphans = listing.objects
				.filter((o) => !keep.has(o.key) && (!opts?.olderThan || o.uploaded < opts.olderThan))
				.map((o) => o.key);
			if (orphans.length) {
				if (!opts?.dryRun) await this.#bucket.delete(orphans);
				deleted += orphans.length;
			}
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
		return deleted;
	}

	#keyFromUrl(url: string): string | null {
		// Mirror owns(): only a URL under our own base yields a key. An off-origin
		// URL whose path starts with '/img/' is not ours (see owns()).
		return url.startsWith(`${this.#base}/`) ? url.slice(this.#base.length + 1) : null;
	}
}
