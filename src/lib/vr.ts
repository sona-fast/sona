/**
 * VR avatar showcase helpers (SONA-124), shared by the public /vr pages and the
 * model-serving endpoints so they can never disagree about what is downloadable
 * or where the model bytes are fetched from.
 */

import * as m from '$lib/paraglide/messages';

/** Licenses under which the raw model file may be offered for download. The
 * download endpoint enforces this server-side; the detail page uses the same
 * predicate to decide whether to render the button at all. */
export function isPermissiveVrLicense(license: string | null | undefined): boolean {
	return license === 'personal-use' || license === 'cc-by';
}

/**
 * The R2 object key a stored model URL's PATH spells, or null when the URL
 * carries none. Deliberately BASE-AGNOSTIC, mirroring the deleteOrphans keep-set
 * rule in $lib/server/storage/r2.ts: a pathname starting with '/img/' keeps its
 * key, anything else is the path minus its leading slash.
 *
 * Base-agnostic because stored model URLs are full PUBLIC URLs absolutized
 * against whatever base was active AT UPLOAD TIME — the R2 custom domain
 * (r2PublicUrl) or the same-origin /img route — and r2PublicUrl can change
 * after upload. Requiring the CURRENT base to match would orphan every model
 * stored under the old one. Deriving a key from a URL we never stored is
 * harmless: model_url is admin-written only, the derived key either misses the
 * bucket (get() → null → 404) or names an object that is public anyway, and the
 * bytes are only ever served through our own endpoints, never fetched from the
 * foreign host by this path.
 */
export function modelKeyFromUrl(
	modelUrl: string | null | undefined,
	origin: string
): string | null {
	if (!modelUrl) return null;
	let parsed: URL;
	try {
		// Resolving against the request origin makes root-relative URLs absolute
		// and normalizes dot segments, so '..' can never leak into a key.
		parsed = new URL(modelUrl, origin);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

	const path = parsed.pathname;
	const key = path.startsWith('/img/') ? path.slice('/img/'.length) : path.replace(/^\//, '');
	return key || null;
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

/** Fine-grained format label for the admin table ("VRM 1.0" / "VRM 0.x").
 * Product/format names, not translatable copy (same reasoning as
 * PLATFORM_LABELS). Uploads record generic 'vrm'; 'vrm0' only appears if set
 * deliberately. The public badge uses the coarser modelFormatLabel above. */
export function modelFormatDetailLabel(format: string | null | undefined): string {
	if (format === 'fbx') return 'FBX';
	if (format === 'vrm0') return 'VRM 0.x';
	return 'VRM 1.0';
}

/** Localized license label ("Personal use"), or null for no/unknown license.
 * Shared by the public detail page and the admin table so the two can't drift. */
export function licenseLabel(license: string | null | undefined): string | null {
	switch (license) {
		case 'personal-use':
			return m.vr_license_personal_use();
		case 'cc-by':
			return m.vr_license_cc_by();
		case 'base-tos':
			return m.vr_license_base_tos();
		case 'all-rights-reserved':
			return m.vr_license_all_rights_reserved();
		default:
			return null;
	}
}

/** Localized credit-role label. role='other' names itself via roleLabel
 * (required in admin forms); falls back to the generic label if a row slipped
 * through without one. Shared by the public credits list and the admin form. */
export function creditRoleLabel(role: string, roleLabel?: string | null): string {
	switch (role) {
		case 'base':
			return m.vr_role_base();
		case 'modeler':
			return m.vr_role_modeler();
		case 'rigger':
			return m.vr_role_rigger();
		case 'texture':
			return m.vr_role_texture();
		case 'shader':
			return m.vr_role_shader();
		default:
			return roleLabel || m.vr_role_other();
	}
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

/** Name shown in the avatar-name placeholder: the character selected in the
 * form, else the first character on the site, so the example reads as this
 * site's own sona instead of a stock one. A site with no characters yet gets a
 * neutral stand-in. */
export function namePlaceholderCharacter(
	characters: { id: number; name: string }[],
	selectedId: string
): string {
	return characters.find((c) => String(c.id) === selectedId)?.name ?? characters[0]?.name ?? 'MySona';
}

/** Hard cap for a self-hosted model upload. Shared (not $lib/server) so the
 * admin upload UI can refuse oversized files before sending a byte, with the
 * server endpoint enforcing the same number against Content-Length. */
export const MAX_VR_MODEL_BYTES = 50 * 1024 * 1024; // 50 MB

/** "12.3 MB"-style size for the format/size chip, download progress and the
 * admin storage line (which needs the GB step for the 10 GB free-tier limit). */
export function formatBytes(bytes: number | null | undefined): string {
	if (!bytes || bytes <= 0) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The .vrm/.fbx extension of an uploaded filename, or null when it carries
 * none we accept. Case-insensitive; the extension is the LAST dot segment, and
 * a leading dot ('.vrm') carries no extension. Lives here (not $lib/server)
 * because the client-side mirror below uses the same rule — one parser instead
 * of two mirror-commented copies (the MAX_VR_MODEL_BYTES precedent);
 * $lib/server/vr-models re-exports it for the endpoint. */
export function modelExtFromFilename(filename: string | null | undefined): 'vrm' | 'fbx' | null {
	if (!filename) return null;
	const dot = filename.lastIndexOf('.');
	if (dot <= 0) return null;
	const ext = filename.slice(dot + 1).toLowerCase();
	return ext === 'vrm' || ext === 'fbx' ? ext : null;
}

/**
 * Client-side validation of a picked model file, extracted from the admin
 * form's onModelPicked so it is unit-testable: mirrors the server guards
 * (shared modelExtFromFilename, MAX_VR_MODEL_BYTES) for instant feedback — the
 * /api/admin/vr-model endpoint re-checks all of it.
 */
export function modelFileError(file: { name: string; size: number }): 'bad-type' | 'too-large' | null {
	if (!modelExtFromFilename(file.name)) return 'bad-type';
	if (file.size > MAX_VR_MODEL_BYTES) return 'too-large';
	return null;
}
