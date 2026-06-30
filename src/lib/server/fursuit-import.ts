// Server-only: import a character's fursuit photos from FurTrack and self-host
// them. For each selected post we download the image, store it via the active
// StorageProvider (R2/UploadThing), and insert a fursuit_photos row. Photos are
// served from the DB afterwards — no FurTrack calls at request time.

import { fursuitPhotos } from '$lib/server/db/schema';
import type { Database } from '$lib/server/db';
import type { SiteSettings } from '$lib/server/settings';
import { getStorage, extFromContentType, isAllowedImageType } from '$lib/server/storage';
import { fetchCharacterPhotos } from '$lib/server/furtrack';
import { LICENSES, type LicenseKey } from '$lib/furtrack/license';
import type { FursuitPhoto } from '$lib/furtrack/types';

/** A row from the fursuit_photos table. */
type FursuitPhotoRow = typeof fursuitPhotos.$inferSelect;

/**
 * Map a stored fursuit_photos row to the FursuitPhoto shape the UI renders.
 * `id` is the DB row id (used for the internal detail link, /gallery/fursuit/[id]).
 */
export function fursuitPhotoFromRow(row: FursuitPhotoRow): FursuitPhoto {
	return {
		id: row.id,
		furtrackUrl: row.furtrackUrl,
		description: row.description ?? undefined,
		imageUrl: row.imageUrl,
		width: row.width ?? undefined,
		height: row.height ?? undefined,
		photographer: row.photographer,
		photographerUrl: row.photographerUrl ?? undefined,
		event: row.event ?? undefined,
		character: row.character,
		tags: [],
		takenAt: row.takenAt ?? undefined,
		license: LICENSES[row.license as LicenseKey] ?? LICENSES.unknown,
		permissionSource: row.permissionSource ?? undefined
	};
}

type Env = App.Platform['env'];

const DOWNLOAD_HEADERS = { Referer: 'https://www.furtrack.com/' };

/**
 * Stable, URL-safe folder slug for a photographer name, used to partition fursuit
 * objects in storage (fursuit/{photographerSlug}/...). Deliberately NOT the shared
 * $lib/server/slugify — that appends a random suffix for uniqueness, which would
 * scatter one photographer's photos across many folders. This is a plain,
 * deterministic slug so the same photographer always maps to the same folder.
 */
export function photographerSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'unknown'
	);
}

/** A FurTrack candidate annotated with its import state for the review UI. */
export interface ImportCandidate extends FursuitPhoto {
	status: 'new' | 'imported' | 'excluded';
}

export interface ImportItemResult {
	postId: number;
	status: 'imported' | 'skipped' | 'failed';
	error?: string;
}

export interface ImportResult {
	imported: number;
	skipped: number;
	failed: number;
	items: ImportItemResult[];
}

/**
 * List a character's FurTrack photos annotated with import state:
 *  - excluded: license doesn't permit reposting (won't import)
 *  - imported: already in fursuit_photos
 *  - new: eligible and not yet imported
 * Returns `null` when the FurTrack feature is disabled (FURTRACK_MODE=off).
 */
export async function getImportCandidates(opts: {
	env: Env | undefined;
	db: Database;
	fetchFn: typeof fetch;
	character: string;
}): Promise<{ candidates: ImportCandidate[]; capped: boolean } | null> {
	const { env, db, fetchFn, character } = opts;
	const result = await fetchCharacterPhotos(env, character, fetchFn, { includeAll: true });
	if (result === null) return null;

	const existing = new Set(
		(await db.select({ fpid: fursuitPhotos.furtrackPostId }).from(fursuitPhotos)).map((r) => r.fpid)
	);

	const candidates: ImportCandidate[] = result.photos.map((p) => ({
		...p,
		// 'imported' wins over the license check: a photo already in the DB stays
		// 'imported' regardless of how it got there (CC license OR manual
		// permission). Otherwise excluded-by-license, otherwise new.
		status: existing.has(p.id) ? 'imported' : !p.license.displayable ? 'excluded' : 'new'
	}));

	return { candidates, capped: result.capped };
}

/**
 * Import the selected posts for a character. Re-fetches candidates server-side
 * (so the client can't import arbitrary/restricted posts), then downloads +
 * self-hosts each eligible, not-yet-imported one.
 */
export async function importFursuitPhotos(opts: {
	env: Env | undefined;
	settings: SiteSettings;
	db: Database;
	fetchFn: typeof fetch;
	character: string;
	postIds: number[];
	/**
	 * Per-post manual permission grants. For each entry, the admin recorded direct
	 * permission from the photographer (e.g. via Telegram DM) for that specific
	 * photo — it gets imported even when the license alone wouldn't permit it.
	 * The map key is the FurTrack postId; the value is the source string we store
	 * verbatim as an audit record (shown publicly as a tooltip on the badge).
	 */
	manualPermissions?: Map<number, string>;
	/** Make a provider's relative URL (R2 dev '/img/...') absolute for storage. */
	absolutize?: (url: string) => string;
}): Promise<ImportResult> {
	const { env, settings, db, fetchFn, character, postIds, manualPermissions = new Map(), absolutize = (u) => u } = opts;
	const wanted = new Set(postIds);

	const fetched = await fetchCharacterPhotos(env, character, fetchFn, { includeAll: true });
	const candidates = fetched?.photos ?? [];
	// Import if selected AND (license permits OR admin recorded direct permission).
	const selected = candidates.filter(
		(p) => wanted.has(p.id) && (p.license.displayable || manualPermissions.has(p.id))
	);

	const existing = new Set(
		(await db.select({ fpid: fursuitPhotos.furtrackPostId }).from(fursuitPhotos)).map((r) => r.fpid)
	);

	const storage = getStorage(env, settings);
	const result: ImportResult = { imported: 0, skipped: 0, failed: 0, items: [] };

	for (const photo of selected) {
		if (existing.has(photo.id)) {
			result.skipped++;
			result.items.push({ postId: photo.id, status: 'skipped' });
			continue;
		}
		try {
			const res = await fetchFn(photo.imageUrl, { headers: DOWNLOAD_HEADERS });
			if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
			const contentType = res.headers.get('content-type') ?? 'image/jpeg';
			// Only self-host safe raster images. A non-image (or SVG) response would be
			// served as active content from the R2 custom domain — refuse it.
			if (!isAllowedImageType(contentType)) throw new Error(`unsupported image type: ${contentType}`);
			const ext = extFromContentType(contentType);

			const { url } = await storage.put({
				suggestedKey: `fursuit/${photographerSlug(photo.photographer)}/${photo.id}.${ext}`,
				body: res.body,
				contentType,
				filename: `${photo.id}.${ext}`
			});

			await db.insert(fursuitPhotos).values({
				furtrackPostId: photo.id,
				character,
				description: photo.description ?? null,
				imageUrl: absolutize(url),
				width: photo.width ?? null,
				height: photo.height ?? null,
				photographer: photo.photographer,
				photographerUrl: photo.photographerUrl ?? null,
				event: photo.event ?? null,
				license: photo.license.key,
				permissionSource: manualPermissions.get(photo.id) ?? null,
				furtrackUrl: photo.furtrackUrl,
				takenAt: photo.takenAt ?? null
			});

			result.imported++;
			result.items.push({ postId: photo.id, status: 'imported' });
		} catch (e) {
			result.failed++;
			result.items.push({ postId: photo.id, status: 'failed', error: e instanceof Error ? e.message : String(e) });
		}
	}

	return result;
}
