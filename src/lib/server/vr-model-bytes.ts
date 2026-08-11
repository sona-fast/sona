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
 *     stays same-origin (connect-src permits no network origin beyond
 *     'self'). R2 is excluded here
 *     because step 1 already probed the bucket: owns() succeeding for R2
 *     would just spell the same missing key again (or loop through /img).
 */
import { modelKeyFromUrl } from '$lib/vr';
import { ALL_PROVIDERS, getStorage } from '$lib/server/storage';
import type { SiteSettings } from '$lib/server/settings';

type Env = App.Platform['env'];

/** Upper bound on the provider-proxy fetch's time-to-headers — a hung
 * upstream must not hold the visitor's request open indefinitely. The body
 * transfer is deliberately unbounded (see resolveModelBytes). */
const PROVIDER_FETCH_TIMEOUT_MS = 10_000;

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
		// Timeout + transport-failure catch: an unresponsive or unresolvable
		// provider must resolve to null (404 upstream) rather than hanging the
		// worker request or escaping as a 500. The timer is cleared once headers
		// arrive — the signal stays associated with res.body, so a still-armed
		// timeout would error the stream mid-transfer, and the transfer is paced
		// by the VISITOR's bandwidth (a multi-MB model on a slow link
		// legitimately outlives any sane header timeout).
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
		let res: Response;
		try {
			res = await fetch(opts.modelUrl, { redirect: 'manual', signal: controller.signal });
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
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
 * are stripped from BOTH sides: R2 httpEtag values are strong, but the
 * provider-proxy branch echoes upstream etags, which are commonly weak — a
 * one-sided strip would make those never revalidate (RFC 9110 weak compare). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
	if (!ifNoneMatch) return false;
	if (ifNoneMatch.trim() === '*') return true;
	const strong = etag.replace(/^W\//, '');
	return ifNoneMatch.split(',').some((t) => t.trim().replace(/^W\//, '') === strong);
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
