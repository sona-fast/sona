/**
 * Per-content-type storage usage for the admin Storage tab (SONA-192).
 *
 * R2 only: the breakdown comes from listing the bucket and classifying each
 * object key by its folder prefix, so it covers files D1 never tracked
 * (orphans, migration leftovers). UploadThing has no per-prefix listing, so
 * callers skip this entirely on UT and keep the aggregate usage bar.
 *
 * Keys can embed personal identifiers (uploader or character names in
 * filenames), so everything here reduces to counts and sums — raw keys must
 * never leave this module, land in a log line, or ride in the page payload.
 */

/** Fixed row order — the UI locks bar-segment order to this. */
export const BREAKDOWN_KINDS = [
	'artwork',
	'vrVideo',
	'vrModel',
	'sticker',
	'vrImage',
	'fursuit',
	'other'
] as const;

export type BreakdownKind = (typeof BREAKDOWN_KINDS)[number];

export interface KindUsage {
	bytes: number;
	count: number;
}

export interface StorageBreakdown {
	totalBytes: number;
	totalCount: number;
	kinds: Record<BreakdownKind, KindUsage>;
}

/** The slice of R2Bucket.list() this module touches (structural, for tests). */
export interface ListableBucket {
	list(options?: {
		cursor?: string;
		limit?: number;
	}): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }>;
}

/**
 * Folder prefix -> content type. `vr-media/` holds both showcase images and
 * `.webm` clips (webm uploads are only accepted for that folder, see
 * /api/upload), so the extension is the discriminator. Anything outside the
 * known content folders — `avatars/` or a stray legacy key — lands in `other`
 * so the rows always sum to the bar total.
 */
export function classifyKey(key: string): BreakdownKind {
	const folder = key.slice(0, key.indexOf('/') + 1);
	switch (folder) {
		case 'artwork/':
			return 'artwork';
		case 'vr-media/':
			return key.toLowerCase().endsWith('.webm') ? 'vrVideo' : 'vrImage';
		case 'vr-models/':
			return 'vrModel';
		case 'stickers/':
			return 'sticker';
		case 'fursuit/':
			return 'fursuit';
		default:
			return 'other';
	}
}

function emptyBreakdown(): StorageBreakdown {
	return {
		totalBytes: 0,
		totalCount: 0,
		kinds: Object.fromEntries(
			BREAKDOWN_KINDS.map((k) => [k, { bytes: 0, count: 0 }])
		) as Record<BreakdownKind, KindUsage>
	};
}

/**
 * One paginated pass over the whole bucket (instead of one list per prefix):
 * fewer subrequests, and unknown prefixes still count toward the total.
 *
 * Bounded: a bucket still truncated after `maxPages` pages (50 × 1000 objects
 * by default) yields null — a partial breakdown would misstate every share, so
 * the caller degrades to the aggregate bar instead.
 */
export async function collectUsageBreakdown(
	bucket: ListableBucket,
	maxPages = 50
): Promise<StorageBreakdown | null> {
	const breakdown = emptyBreakdown();
	let cursor: string | undefined;
	let pages = 0;
	do {
		if (pages >= maxPages) return null;
		pages += 1;
		const page = await bucket.list({ cursor, limit: 1000 });
		for (const object of page.objects) {
			const kind = breakdown.kinds[classifyKey(object.key)];
			kind.bytes += object.size;
			kind.count += 1;
			breakdown.totalBytes += object.size;
			breakdown.totalCount += 1;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return breakdown;
}
