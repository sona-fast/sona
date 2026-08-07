import { eq } from 'drizzle-orm';
import { images } from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';
import { extFromContentType, isAllowedImageType } from './index';
import { sniffImageType } from './sniff';
import type { StorageProvider } from './types';

export interface MigrationItemResult {
	imageId: number;
	status: 'migrated' | 'skipped' | 'failed';
	/** Old URL, kept so a later cleanup step can delete the original. */
	oldImageUrl?: string;
	error?: string;
}

export interface MigrationResult {
	total: number;
	migrated: number;
	skipped: number;
	failed: number;
	items: MigrationItemResult[];
}

/**
 * Copy every image to `target` and repoint the DB at the new URLs.
 *
 * Non-destructive + resumable:
 * - Images already served by `target` are skipped (so a re-run resumes safely).
 * - Originals are NOT deleted — the DB is updated per item, and `oldImageUrl` is
 *   returned so an explicit cleanup step can remove the source files later.
 *
 * Note: switching the *active* provider for NEW uploads is a separate setting
 * flip (storageProvider) — this only moves existing files.
 */
export async function migrateImages(opts: {
	db: Database;
	fetchFn: typeof fetch;
	target: StorageProvider;
	onProgress?: (done: number, total: number) => void;
}): Promise<MigrationResult> {
	const { db, fetchFn, target, onProgress } = opts;

	const rows = await db
		.select({
			id: images.id,
			slug: images.slug,
			imageUrl: images.imageUrl,
			thumbnailUrl: images.thumbnailUrl
		})
		.from(images);

	const result: MigrationResult = {
		total: rows.length,
		migrated: 0,
		skipped: 0,
		failed: 0,
		items: []
	};

	let done = 0;
	for (const row of rows) {
		try {
			if (target.owns(row.imageUrl)) {
				result.skipped++;
				result.items.push({ imageId: row.id, status: 'skipped' });
			} else {
				const newImageUrl = await copyOne(fetchFn, target, row.imageUrl, `artwork/${row.slug}`);

				let newThumb = row.thumbnailUrl;
				if (row.thumbnailUrl && !target.owns(row.thumbnailUrl)) {
					newThumb = await copyOne(fetchFn, target, row.thumbnailUrl, `artwork/${row.slug}-thumb`);
				}

				await db
					.update(images)
					.set({ imageUrl: newImageUrl, thumbnailUrl: newThumb })
					.where(eq(images.id, row.id));

				result.migrated++;
				result.items.push({ imageId: row.id, status: 'migrated', oldImageUrl: row.imageUrl });
			}
		} catch (e) {
			result.failed++;
			result.items.push({
				imageId: row.id,
				status: 'failed',
				error: e instanceof Error ? e.message : String(e)
			});
		}
		onProgress?.(++done, rows.length);
	}

	return result;
}

export interface BatchProgress {
	total: number;
	done: number;
	migrated: number;
	failed: number;
	remaining: number;
	failures: { imageId: number; error: string }[];
	/** Items processed this batch, for the live "recent activity" list. */
	recent: { slug: string; status: 'migrated' | 'failed' }[];
}

/**
 * Migrate up to `batchSize` not-yet-migrated images to `target`, repointing the
 * DB. Designed to be called repeatedly from the client (so a large migration
 * stays within Worker limits and shows progress); resumable because images
 * already served by `target` are never reprocessed.
 *
 * `absolutize` converts a provider's relative URL (R2 in dev returns '/img/...')
 * into an absolute one for storage.
 */
export async function migrateNextBatch(opts: {
	db: Database;
	fetchFn: typeof fetch;
	target: StorageProvider;
	batchSize: number;
	absolutize?: (url: string) => string;
}): Promise<BatchProgress> {
	const { db, fetchFn, target, batchSize, absolutize = (u) => u } = opts;

	const rows = await db
		.select({
			id: images.id,
			slug: images.slug,
			imageUrl: images.imageUrl,
			thumbnailUrl: images.thumbnailUrl
		})
		.from(images);

	const pending = rows.filter((r) => !target.owns(r.imageUrl));
	const doneBefore = rows.length - pending.length;
	const batch = pending.slice(0, batchSize);

	let migrated = 0;
	let failed = 0;
	const failures: { imageId: number; error: string }[] = [];
	const recent: { slug: string; status: 'migrated' | 'failed' }[] = [];

	for (const row of batch) {
		try {
			const newImageUrl = absolutize(await copyOne(fetchFn, target, row.imageUrl, `artwork/${row.slug}`));
			let newThumb = row.thumbnailUrl;
			if (row.thumbnailUrl && !target.owns(row.thumbnailUrl)) {
				newThumb = absolutize(await copyOne(fetchFn, target, row.thumbnailUrl, `artwork/${row.slug}-thumb`));
			}
			await db.update(images).set({ imageUrl: newImageUrl, thumbnailUrl: newThumb }).where(eq(images.id, row.id));
			migrated++;
			recent.push({ slug: row.slug, status: 'migrated' });
		} catch (e) {
			failed++;
			failures.push({ imageId: row.id, error: e instanceof Error ? e.message : String(e) });
			recent.push({ slug: row.slug, status: 'failed' });
		}
	}

	return {
		total: rows.length,
		done: doneBefore + migrated,
		migrated,
		failed,
		// failed items stay pending for a retry
		remaining: pending.length - migrated,
		failures,
		recent
	};
}

async function copyOne(
	fetchFn: typeof fetch,
	target: StorageProvider,
	url: string,
	baseKey: string
): Promise<string> {
	const res = await fetchFn(url);
	if (!res.ok) throw new Error(`fetch ${res.status} for ${url}`);
	// Stream when the source declares its usable length (both providers upload
	// without materializing given a size). Content-Encoding responses can't
	// stream: their Content-Length counts compressed bytes while res.body
	// yields decoded ones, so the declared size would be wrong. A response
	// without a usable length falls back to buffering the whole body — uncapped,
	// the pre-existing behavior of this path.
	const declaredSize = Number(res.headers.get('content-length'));
	const streamable =
		res.body &&
		Number.isFinite(declaredSize) &&
		declaredSize > 0 &&
		!res.headers.get('content-encoding');

	// Verify the LEADING BYTES are an allowed raster image (M7, the same defense
	// as /api/upload) rather than trusting the source's Content-Type header:
	// migrate re-hosts onto the CDN origin, which serves the stored type past
	// the worker's security headers, so text/html or SVG must never be copied.
	// The sniffed type is also what gets STORED — a source serving honest bytes
	// under a generic header (application/octet-stream) migrates with a
	// corrected type instead of failing. On the streaming path the sniffed head
	// is re-prepended, so the provider still sees the full body.
	let body: ReadableStream<Uint8Array> | Uint8Array;
	let head: Uint8Array;
	let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	if (streamable) {
		const reader = res.body!.getReader();
		sourceReader = reader;
		const { chunks, bytes } = await readAtLeast(reader, SNIFF_BYTES);
		head = bytes;
		body = prependChunks(chunks, reader);
	} else {
		const buffered = new Uint8Array(await res.arrayBuffer());
		head = buffered;
		body = buffered;
	}
	const sniffed = sniffImageType(head.slice(0, SNIFF_BYTES));
	if (!isAllowedImageType(sniffed)) {
		// Release the source on the streaming path — without the cancel the
		// locked, undrained body keeps the connection open past the throw.
		await sourceReader?.cancel().catch(() => {});
		throw new Error(
			`source is not an allowed raster image (sniffed ${sniffed ?? 'no known signature'}) for ${url}`
		);
	}
	const contentType = sniffed!;
	const ext = extFromContentType(contentType);
	const { url: newUrl } = await target.put({
		suggestedKey: `${baseKey}.${ext}`,
		body,
		size: streamable ? declaredSize : undefined,
		contentType,
		filename: `${baseKey.split('/').pop()}.${ext}`
	});
	return newUrl;
}

/** 64 bytes: enough for every raster signature, incl. AVIF ftyp compatible_brands. */
const SNIFF_BYTES = 64;

/** Read chunks off `reader` until at least `n` bytes have arrived (or EOF). */
async function readAtLeast(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	n: number
): Promise<{ chunks: Uint8Array[]; bytes: Uint8Array }> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (total < n) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		total += value.length;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return { chunks, bytes };
}

/** A stream that replays the already-read `chunks`, then drains `reader`. */
function prependChunks(
	chunks: Uint8Array[],
	reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(chunks[i++]);
				return;
			}
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
}
