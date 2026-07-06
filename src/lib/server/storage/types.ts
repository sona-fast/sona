import type { StorageProviderId } from '$lib/server/settings';

export type { StorageProviderId };

export interface PutInput {
	/** Suggested object key (used by R2; UploadThing generates its own key). */
	suggestedKey: string;
	/**
	 * The bytes. A ReadableStream lets R2 stream straight to the bucket without
	 * buffering the whole file; UploadThing buffers internally since it needs a File.
	 */
	body: ReadableStream | Uint8Array | ArrayBuffer;
	contentType: string;
	filename: string;
}

export interface PutResult {
	/** Public URL to store in the DB and serve to visitors. */
	url: string;
}

export interface DeleteOrphansOptions {
	/**
	 * Only treat objects uploaded before this time as orphans. Protects
	 * in-flight uploads: /api/upload stores bytes before any D1 row references
	 * them, so a just-uploaded object always looks orphaned. Both providers
	 * honor it (R2 via object.uploaded, UploadThing via file.uploadedAt).
	 */
	olderThan?: Date;
	/** Count orphans without deleting anything. */
	dryRun?: boolean;
}

/**
 * A pluggable image store. The whole site (artwork gallery + fursuit photos)
 * uses one active provider at a time; migration copies between providers.
 */
export interface StorageProvider {
	readonly id: StorageProviderId;
	/** Upload bytes and return the public URL. */
	put(input: PutInput): Promise<PutResult>;
	/** Delete a previously stored file by the public URL we recorded. */
	deleteByUrl(url: string): Promise<void>;
	/** True if this URL is served by this provider (used to skip already-migrated files). */
	owns(url: string): boolean;
	/**
	 * Delete every object in this store that is NOT in `referencedUrls`
	 * (orphan cleanup). Returns the number of files deleted (or, with
	 * `dryRun`, the number that would be).
	 */
	deleteOrphans(referencedUrls: string[], opts?: DeleteOrphansOptions): Promise<number>;
}
