/**
 * Server-side model byte resolution (SONA-124), shared by the viewer endpoint
 * (/vr/[slug]/model) and the download route so the two can never disagree
 * about where the bytes come from. Provider-aware on purpose: uploads land on
 * whichever storage provider is ACTIVE (default UploadThing on unconfigured
 * forks), while the old serving path was R2-only — an UploadThing fork's
 * upload used to succeed and then 404 forever.
 *
 * Resolution order:
 *  1. R2 by the key the stored URL's path spells (modelKeyFromUrl — the
 *     base-agnostic deleteOrphans rule), so a changed r2PublicUrl can't orphan
 *     a stored object.
 *  2. If the ACTIVE provider owns the URL and isn't R2 (UploadThing), an
 *     outbound fetch of the provider URL, streamed through — the visitor's own
 *     fetch stays same-origin (CSP connect-src 'self' intact). R2 is excluded
 *     here because step 1 already probed the bucket: owns() succeeding for R2
 *     would just spell the same missing key again (or loop through /img).
 */
import { modelKeyFromUrl } from '$lib/vr';
import { getStorage } from '$lib/server/storage';
import type { SiteSettings } from '$lib/server/settings';

type Env = App.Platform['env'];

export interface ModelBytesOpts {
	modelUrl: string;
	origin: string;
	env: Env | undefined;
	settings: SiteSettings;
}

export interface ResolvedModelBytes {
	body: ReadableStream;
	/** Byte length when the source declares one (R2 always does), else null. */
	size: number | null;
	etag: string | null;
}

function providerFetchable(opts: ModelBytesOpts): boolean {
	try {
		const storage = getStorage(opts.env, opts.settings);
		return storage.id !== 'r2' && storage.owns(opts.modelUrl);
	} catch {
		// Provider not configured — nothing to fetch from.
		return false;
	}
}

/** Open the model's bytes for streaming, or null when nothing serves this URL. */
export async function resolveModelBytes(opts: ModelBytesOpts): Promise<ResolvedModelBytes | null> {
	const key = modelKeyFromUrl(opts.modelUrl, opts.origin);
	if (key) {
		const object = await opts.env?.IMAGES?.get(key);
		if (object) {
			return { body: object.body as ReadableStream, size: object.size, etag: object.httpEtag };
		}
	}
	if (providerFetchable(opts)) {
		const res = await fetch(opts.modelUrl);
		if (res.ok && res.body) {
			const len = res.headers.get('content-length');
			return {
				body: res.body,
				size: len && Number.isInteger(Number(len)) ? Number(len) : null,
				etag: res.headers.get('etag')
			};
		}
	}
	return null;
}

/**
 * Cheap "would resolveModelBytes succeed?" probe for page loads: an R2 head()
 * instead of a get(), and for a non-R2 provider just the owns() check (no
 * outbound request per page view — a stale provider URL then 404s at fetch
 * time, which the viewer surfaces as its load-failed state).
 */
export async function modelBytesServable(opts: ModelBytesOpts): Promise<boolean> {
	const key = modelKeyFromUrl(opts.modelUrl, opts.origin);
	if (key && (await opts.env?.IMAGES?.head(key))) return true;
	return providerFetchable(opts);
}
