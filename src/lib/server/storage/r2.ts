import type { R2Bucket } from '@cloudflare/workers-types';
import type { StorageProvider, PutInput, PutResult } from './types';

export interface R2Options {
	/** The R2 bucket binding (platform.env.IMAGES). */
	bucket: R2Bucket;
	/**
	 * Public base URL objects are served from, no trailing slash.
	 * Prod: the bucket's custom domain (https://cdn.sparky.ink).
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
		if (url.startsWith(`${this.#base}/`)) return true;
		// Dev stores an absolutized form of the relative '/img' base
		// (http://host/img/...); match by path so it's still recognized as ours.
		if (this.#base.startsWith('/')) {
			try {
				return new URL(url).pathname.startsWith(`${this.#base}/`);
			} catch {
				return false;
			}
		}
		return false;
	}

	async deleteOrphans(referencedUrls: string[]): Promise<number> {
		const keep = new Set(
			referencedUrls.map((u) => this.#keyFromUrl(u)).filter((k): k is string => !!k)
		);
		let deleted = 0;
		let cursor: string | undefined;
		do {
			const listing = await this.#bucket.list(cursor ? { cursor, limit: 1000 } : { limit: 1000 });
			const orphans = listing.objects.map((o) => o.key).filter((k) => !keep.has(k));
			if (orphans.length) {
				await this.#bucket.delete(orphans);
				deleted += orphans.length;
			}
			cursor = listing.truncated ? listing.cursor : undefined;
		} while (cursor);
		return deleted;
	}

	#keyFromUrl(url: string): string | null {
		if (url.startsWith(`${this.#base}/`)) return url.slice(this.#base.length + 1);
		if (this.#base.startsWith('/')) {
			try {
				const path = new URL(url).pathname;
				if (path.startsWith(`${this.#base}/`)) return path.slice(this.#base.length + 1);
			} catch {
				return null;
			}
		}
		return null;
	}
}
