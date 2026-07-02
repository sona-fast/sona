import { dev } from '$app/environment';
import type { SiteSettings, StorageProviderId } from '$lib/server/settings';
import type { StorageProvider } from './types';
import { R2Storage } from './r2';
import { UploadThingStorage } from './uploadthing';

export type { StorageProvider } from './types';

type Env = App.Platform['env'];

/**
 * Resolve the active StorageProvider from settings (or an explicit override,
 * which migration uses to construct the *target* provider).
 */
export function getStorage(
	env: Env | undefined,
	settings: SiteSettings,
	providerId: StorageProviderId = settings.storageProvider
): StorageProvider {
	if (providerId === 'r2') {
		if (!env?.IMAGES) {
			throw new Error('R2 selected but the IMAGES bucket binding is not available');
		}
		// In dev the custom domain fronts the real bucket, not miniflare's local
		// one, so serve through our own /img route. In prod, fall back to that same
		// /img route when no public/CDN URL is configured yet, rather than emitting
		// broken bare-key URLs (missing the domain). The /img route serves from the
		// bucket in prod too, so objects stay reachable until a CDN URL is set.
		const publicBase = dev || !settings.r2PublicUrl ? '/img' : settings.r2PublicUrl;
		return new R2Storage({ bucket: env.IMAGES, publicBase });
	}

	const token = env?.UPLOADTHING_TOKEN;
	if (!token) throw new Error('UploadThing selected but UPLOADTHING_TOKEN is not configured');
	return new UploadThingStorage({ token });
}

const EXT_BY_TYPE: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'image/svg+xml': 'svg',
	'video/webm': 'webm',
	// Telegram animated stickers are decompressed to plain Lottie JSON before storage.
	'application/json': 'json'
};

/** A clean file extension for a content-type (e.g. image/svg+xml → svg). */
export function extFromContentType(contentType: string): string {
	const base = contentType.split(';')[0].trim().toLowerCase();
	return EXT_BY_TYPE[base] ?? base.split('/')[1]?.replace(/[^a-z0-9]/g, '') ?? 'bin';
}

// Content-types accepted for stored, publicly-served images. Deliberately raster
// only — NOT image/svg+xml or any document/active type. Stored objects are served
// from the R2 custom domain (which serves them directly with their stored
// content-type, bypassing the worker's security headers), so an SVG with a <script>
// or a text/html payload would execute in that origin. Keep this strict.
const ALLOWED_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/jpg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif'
]);

/** Whether a content-type is a safe raster image we'll store and serve publicly. */
export function isAllowedImageType(contentType: string | null | undefined): boolean {
	if (!contentType) return false;
	return ALLOWED_IMAGE_TYPES.has(contentType.split(';')[0].trim().toLowerCase());
}

// Content-types accepted for stored, publicly-served STICKER media. A superset of
// the raster image set, deliberately widened for sticker formats only:
//  - video/webm — Telegram video stickers. Not active content in the cdn origin.
//  - application/json — Telegram animated (.tgs) stickers, gunzipped to plain
//    Lottie JSON at import time. JSON is data, not script; safe to serve.
// Still NO svg/html/active types — same reasoning as ALLOWED_IMAGE_TYPES (objects
// are served from the R2 custom domain with their stored content-type, past the worker's
// security headers). Keep this strict; only add provably-inert media types.
const ALLOWED_STICKER_TYPES = new Set([
	'image/png',
	'image/webp',
	'image/gif',
	'video/webm',
	'application/json'
]);

/** Whether a content-type is a sticker medium we'll store and serve publicly. */
export function isAllowedStickerType(contentType: string | null | undefined): boolean {
	if (!contentType) return false;
	return ALLOWED_STICKER_TYPES.has(contentType.split(';')[0].trim().toLowerCase());
}

const ALL_PROVIDERS: StorageProviderId[] = ['r2', 'uploadthing'];

/**
 * True if `url` is served by any configured provider (i.e. we host it). Used to
 * reject externally-hosted URLs submitted through admin forms, so stored sticker
 * and cover media is always self-hosted and can never be an off-origin reference.
 */
export function isOwnedUrl(env: Env | undefined, settings: SiteSettings, url: string): boolean {
	for (const id of ALL_PROVIDERS) {
		try {
			if (getStorage(env, settings, id).owns(url)) return true;
		} catch {
			// provider not configured — skip
		}
	}
	return false;
}

/** Delete one stored file by URL, routing to whichever provider actually owns it. */
export async function deleteFile(env: Env | undefined, settings: SiteSettings, url: string): Promise<void> {
	for (const id of ALL_PROVIDERS) {
		try {
			const provider = getStorage(env, settings, id);
			if (provider.owns(url)) {
				await provider.deleteByUrl(url);
				return;
			}
		} catch {
			// provider not configured — skip
		}
	}
}

/** Delete orphaned objects (not referenced by `referencedUrls`) across every configured provider. */
export async function deleteOrphansAll(
	env: Env | undefined,
	settings: SiteSettings,
	referencedUrls: string[]
): Promise<number> {
	let deleted = 0;
	for (const id of ALL_PROVIDERS) {
		try {
			deleted += await getStorage(env, settings, id).deleteOrphans(referencedUrls);
		} catch {
			// provider not configured — skip
		}
	}
	return deleted;
}
