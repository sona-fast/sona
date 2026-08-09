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
 *  2. If ANY configured non-R2 provider owns the URL (UploadThing — active or
 *     not, so a provider switch can't orphan an earlier upload), an outbound
 *     fetch of the provider URL, streamed through — the visitor's own fetch
 *     stays same-origin (CSP connect-src 'self' intact). R2 is excluded here
 *     because step 1 already probed the bucket: owns() succeeding for R2
 *     would just spell the same missing key again (or loop through /img).
 */
import { modelKeyFromUrl } from '$lib/vr';
import { ALL_PROVIDERS, getStorage } from '$lib/server/storage';
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
	// EVERY configured provider, not just the active one (the isOwnedUrl /
	// deleteFile precedent in storage/index.ts): a model uploaded while
	// UploadThing was active must stay servable after the fork switches to R2 —
	// the migrate tool never repoints vr model URLs. R2 is skipped because step
	// 1 of resolveModelBytes already probed the bucket by key.
	for (const id of ALL_PROVIDERS) {
		if (id === 'r2') continue;
		try {
			if (getStorage(opts.env, opts.settings, id).owns(opts.modelUrl)) return true;
		} catch {
			// Provider not configured — nothing to fetch from.
		}
	}
	return false;
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
		// redirect: 'manual' — owns() anchored this URL to a provider host we
		// trust; following a redirect would let that host bounce the stream to an
		// arbitrary origin (SSRF via redirect). A 3xx is treated as unresolvable.
		const res = await fetch(opts.modelUrl, { redirect: 'manual' });
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

/** Whether an If-None-Match header names `etag` (comma-separated list or *).
 * Shared by the model + download routes so both answer conditional
 * revalidation with a 304 instead of re-streaming a multi-MB body. W/ prefixes
 * are tolerated on the request side; R2 httpEtag values are strong. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
	if (!ifNoneMatch) return false;
	if (ifNoneMatch.trim() === '*') return true;
	return ifNoneMatch.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
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
