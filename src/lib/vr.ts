/**
 * VR avatar showcase helpers (SONA-124), shared by the public /vr pages and the
 * model download endpoint so the two can never disagree about what is
 * downloadable or where the model bytes are fetched from.
 */

/** Licenses under which the raw model file may be offered for download. The
 * download endpoint enforces this server-side; the detail page uses the same
 * predicate to decide whether to render the button at all. */
export function isPermissiveVrLicense(license: string | null | undefined): boolean {
	return license === 'personal-use' || license === 'cc-by';
}

/**
 * The R2 object key behind a stored model URL, or null when the URL isn't ours.
 *
 * Stored model URLs are full PUBLIC URLs (see vr_avatars.model_url), absolutized
 * against whatever base was active at upload time — the R2 custom domain
 * (r2PublicUrl), or the same-origin /img route when no CDN URL was set. The key
 * derivation mirrors deleteOrphans in $lib/server/storage/r2.ts: a pathname
 * starting with '/img/' keeps its key, anything else is the path minus its
 * leading slash.
 *
 * Ownership is checked FIRST: only a root-relative URL or one on the request
 * origin / the configured r2PublicUrl yields a key. A foreign host must return
 * null — the viewer would try to fetch it same-origin (and 404), and the
 * download route would otherwise stream whatever key a foreign URL's path
 * happens to spell (an off-origin reference is not ours to serve).
 */
export function deriveModelKey(
	modelUrl: string | null | undefined,
	opts: { origin: string; r2PublicUrl?: string | null }
): string | null {
	if (!modelUrl) return null;
	let parsed: URL;
	try {
		// Resolving against the request origin makes root-relative URLs absolute
		// and normalizes dot segments, so '..' can never leak into a key.
		parsed = new URL(modelUrl, opts.origin);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

	const owned =
		isSameOrigin(parsed, opts.origin) ||
		(!!opts.r2PublicUrl && isSameOrigin(parsed, opts.r2PublicUrl)) ||
		// A root-relative stored URL resolves to the request origin above, so this
		// branch only matters when modelUrl was absolute to begin with.
		modelUrl.startsWith('/');
	if (!owned) return null;

	const path = parsed.pathname;
	const key = path.startsWith('/img/') ? path.slice('/img/'.length) : path.replace(/^\//, '');
	return key || null;
}

function isSameOrigin(url: URL, base: string): boolean {
	try {
		return url.origin === new URL(base).origin;
	} catch {
		return false;
	}
}

/**
 * The SAME-ORIGIN path the 3D viewer fetches the model from. The app CSP sends
 * connect-src 'self', so the viewer must never be handed the raw (possibly
 * cross-origin) model_url — this routes it through the /img serving route
 * instead. Null = no self-hosted model reachable → no viewer.
 */
export function deriveModelPath(
	modelUrl: string | null | undefined,
	opts: { origin: string; r2PublicUrl?: string | null }
): string | null {
	const key = deriveModelKey(modelUrl, opts);
	return key ? `/img/${key}` : null;
}

/** File extension a model download carries, by stored model_format.
 * 'vrm0' is still a .vrm file (VRM 0.x is a version, not a container). */
export function modelExt(format: string | null | undefined): 'vrm' | 'fbx' {
	return format === 'fbx' ? 'fbx' : 'vrm';
}

/** Short format label for badges/chips ("3D · VRM"). */
export function modelFormatLabel(format: string | null | undefined): string {
	return format === 'fbx' ? 'FBX' : 'VRM';
}

/** Whether the in-page viewer can load this format (three-vrm handles VRM 0.x
 * and 1.0; FBX models are download/external-only). */
export function viewerSupports(format: string | null | undefined): boolean {
	return format === 'vrm' || format === 'vrm0';
}

// Display names for the off-site homes avatars commonly live at; anything else
// falls back to its hostname so the link card still names its destination.
const EXTERNAL_SITE_NAMES: Record<string, string> = {
	'hub.vroid.com': 'VRoid Hub',
	'booth.pm': 'BOOTH',
	'gumroad.com': 'Gumroad',
	'jinxxy.com': 'Jinxxy',
	'payhip.com': 'Payhip'
};

/** Human name of an external URL's destination ("VRoid Hub"), or null when the
 * URL doesn't parse. Subdomains resolve to their registered name (shop.booth.pm
 * → BOOTH); unknown hosts show their bare hostname. */
export function externalSiteName(url: string | null | undefined): string | null {
	if (!url) return null;
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
	const bare = host.replace(/^www\./, '');
	if (EXTERNAL_SITE_NAMES[bare]) return EXTERNAL_SITE_NAMES[bare];
	for (const [domain, name] of Object.entries(EXTERNAL_SITE_NAMES)) {
		if (bare.endsWith(`.${domain}`)) return name;
	}
	return bare;
}

/** Platform badge labels. These are product names, not translatable copy;
 * 'other' has no fixed name and is labeled by the page via i18n. */
const PLATFORM_LABELS: Record<string, string> = {
	vrchat: 'VRChat',
	resonite: 'Resonite',
	chilloutvr: 'ChilloutVR',
	neosvr: 'NeosVR',
	vseeface: 'VSeeFace',
	warudo: 'Warudo'
};

export function platformLabel(platform: string): string | null {
	return PLATFORM_LABELS[platform] ?? null;
}

/** Hard cap for a self-hosted model upload. Shared (not $lib/server) so the
 * admin upload UI can refuse oversized files before sending a byte, with the
 * server endpoint enforcing the same number against Content-Length. */
export const MAX_VR_MODEL_BYTES = 50 * 1024 * 1024; // 50 MB

/** "12.3 MB"-style size for the format/size chip and download progress. */
export function formatBytes(bytes: number | null | undefined): string {
	if (!bytes || bytes <= 0) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
