import type { StorageProviderId } from '$lib/server/settings';

export type { StorageProviderId };

export interface PutInput {
	/** Suggested object key (used by R2; UploadThing generates its own key). */
	suggestedKey: string;
	/**
	 * The bytes. A ReadableStream uploads without materializing the whole body
	 * ONLY when `size` is also given — both providers need the total length up
	 * front (R2 for the object length, UploadThing for the presigned ingest
	 * URL). A stream without a size falls back to bounded in-memory buffering
	 * under MAX_BUFFER_BYTES.
	 */
	body: ReadableStream | Uint8Array | ArrayBuffer;
	/**
	 * Total byte length of `body` when it is a ReadableStream. Callers always
	 * know it (File.size, Content-Length) — pass it so large bodies stream
	 * instead of buffering. If the stream turns out longer than declared, the
	 * put fails rather than silently storing a truncated or oversized object.
	 */
	size?: number;
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
	/**
	 * Refuse to delete anything (throw ZeroKeepError instead) when the store
	 * holds objects but NOT ONE referenced URL resolved to a key. An empty keep
	 * set means reference derivation is broken (empty collector result,
	 * unmappable URLs) and EVERY object would be judged an orphan. Safety belt
	 * for the unattended cron path; the manual admin buttons don't set it
	 * (deleteAll legitimately passes zero references to wipe the store).
	 */
	abortOnEmptyKeepSet?: boolean;
}

/**
 * Thrown by deleteOrphans when `abortOnEmptyKeepSet` is set and the keep set
 * came out empty while the store still holds objects. deleteOrphansAll turns
 * this into a reported "skipped" anomaly rather than a failure.
 */
export class ZeroKeepError extends Error {}

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
