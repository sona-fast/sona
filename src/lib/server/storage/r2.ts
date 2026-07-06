import type { R2Bucket } from '@cloudflare/workers-types';
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

	async put({ suggestedKey, body, contentType }: PutInput): Promise<PutResult> {
		const key = suggestedKey.replace(/^\/+/, '');
		// R2 requires a known content length; a raw ReadableStream (download/upload
		// body) doesn't have one, so buffer streams before storing. ArrayBuffer /
		// Uint8Array already have a length and pass through.
		const data = body instanceof ReadableStream ? await new Response(body).arrayBuffer() : body;
		// Stored images are immutable (content-addressed by a random-uuid key), so
		// give them an explicit 1-day cache instead of relying on Cloudflare's 4h
		// zone default. CF Image Transformations inherit this, so resized thumbnails
		// cache for a day too rather than regenerating every 4h.
		await this.#bucket.put(key, data as ArrayBuffer | Uint8Array, {
			httpMetadata: { contentType, cacheControl: 'public, max-age=86400' }
		});
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
		const keep = new Set(
			referencedUrls.map((u) => this.#keyFromUrl(u)).filter((k): k is string => !!k)
		);
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
