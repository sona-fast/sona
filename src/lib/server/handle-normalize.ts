// Handle normalization for matching a registry artist against LOCAL artists when
// pulling. Mirrors the registry's src/lib/normalize.ts so the two agree on what
// counts as "the same handle". Pure — no DB.
//
// The platform table + bare-handle normalizer live in the client-safe
// `$lib/handle-classify` and `$lib/social-platforms` (the New Artist combobox
// and the public pages need them too); re-exported here so existing server
// importers keep their `handle-normalize` import path.

import { sanitizeUrl, stripControlChars } from './validate';
import { socialHandle } from '../social-label';
import { SOCIAL_KEY_TO_PLATFORM, normalizeHandle } from '../handle-classify';
import {
	RESERVED_SEGMENTS,
	deviantArtUserSubdomain,
	extractHandle,
	platformDomains,
	type Platform,
	type SocialPlatform
} from '../social-platforms';

export { SOCIAL_KEY_TO_PLATFORM, normalizeHandle, type Platform };

/** Letters, digits, and . _ - — what a bare handle may contain (Bluesky handles
 *  contain dots). */
const HANDLE_CHARS = /^[A-Za-z0-9._-]+$/;

/** sanitizeUrl's length cap (validate.ts), mirrored for the flattened Patreon URL,
 *  which is returned without passing through sanitizeUrl. Keep the two equal. */
const MAX_URL_LENGTH = 2048;

export interface NormalizedHandle {
	platform: Platform;
	handleNorm: string;
}

export function socialsToHandles(socials: Record<string, unknown>): NormalizedHandle[] {
	const out: NormalizedHandle[] = [];
	for (const [key, platform] of Object.entries(SOCIAL_KEY_TO_PLATFORM)) {
		const raw = socials[key];
		if (typeof raw !== 'string') continue;
		const handleNorm = normalizeHandle(platform, raw);
		if (handleNorm) out.push({ platform, handleNorm });
	}
	return out;
}

/** True if two socials objects share at least one normalized (platform, handle). */
export function handlesOverlap(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const bh = socialsToHandles(b);
	if (bh.length === 0) return false;
	const set = new Set(bh.map((h) => `${h.platform} ${h.handleNorm}`));
	return socialsToHandles(a).some((h) => set.has(`${h.platform} ${h.handleNorm}`));
}

/**
 * A Bluesky handle as the profile link it stands for. A bare handle and a
 * profile link are not read alike: the shared reader drops a leading "www."
 * from a bare value as part of a web address, and on Bluesky that label is part
 * of the handle. In link form "www.artist.example" and "artist.example" stay
 * two accounts, on this side and in the stored link it is compared with.
 */
export function blueskyHandleLink(handle: string): string {
	return `https://bsky.app/profile/${handle.trim().replace(/^@+/, '')}`;
}

/**
 * Rows whose stored socials hold one of `handles` on `platform`. Compares the
 * normalized forms `handlesOverlap` uses, so a pasted x.com link finds an
 * artist stored as twitter.com in any letter case, and the same name on another
 * platform is someone else. A full scan: there's no handle index, and a site
 * has tens to hundreds of artists.
 */
export function findLocalArtistsByHandle<T extends Record<string, unknown>>(
	rows: T[],
	platform: Platform,
	handles: string[]
): T[] {
	// A bare Bluesky handle is read as its profile link, on the wanted side and
	// on the stored one (a legacy row can hold a bare handle), so a leading
	// "www." survives on both sides or on neither. Every other value is read as
	// socialsToHandles reads it.
	const read = (h: string) =>
		normalizeHandle(platform, platform === 'bluesky' && !h.includes('/') ? blueskyHandleLink(h) : h);
	const wanted = new Set(handles.map(read).filter((h) => h !== ''));
	if (wanted.size === 0) return [];
	const stored = (row: T) =>
		Object.entries(SOCIAL_KEY_TO_PLATFORM)
			.filter(([key, p]) => p === platform && typeof row[key] === 'string')
			.map(([key]) => read(row[key] as string));
	return rows.filter(
		(row) =>
			stored(row).some((h) => wanted.has(h)) ||
			storedProfileHandles(row, platform).some((h) => wanted.has(h)) ||
			(platform === 'deviantart' && wanted.has(legacyDeviantArtHandle(row.deviantArtUrl) ?? ''))
	);
}

/**
 * The handles in a row's stored `platform` links, read the way the pasted link
 * is (socialHandle), so a profile on the platform's own subdomain matches:
 * normalizeHandle reads https://sfw.furaffinity.net/user/taro as
 * "sfw.furaffinity.net", and changing that would change registry matching on
 * every fork. Only this lookup reads it as "taro".
 */
function storedProfileHandles(row: Record<string, unknown>, platform: Platform): string[] {
	const out: string[] = [];
	for (const [key, p] of Object.entries(SOCIAL_KEY_TO_PLATFORM)) {
		const stored = row[key];
		if (p !== platform || typeof stored !== 'string') continue;
		const read = socialHandle(platform, stored) ?? '';
		const handle = normalizeHandle(platform, platform === 'bluesky' && read ? blueskyHandleLink(read) : read);
		if (handle) out.push(handle);
	}
	return out;
}

/**
 * The user in a stored legacy DeviantArt link, https://<user>.deviantart.com/,
 * case-folded. normalizeHandle reads that host as the handle
 * "<user>.deviantart.com", and changing it would change registry matching on
 * every fork, so only this lookup reads the legacy form.
 */
function legacyDeviantArtHandle(stored: unknown): string | null {
	if (typeof stored !== 'string' || !stored.trim()) return null;
	const text = stored.trim();
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text.replace(/^\/\//, '')}`);
		return deviantArtUserSubdomain(url.hostname)?.toLowerCase() ?? null;
	} catch {
		return null;
	}
}

/** Canonical profile-URL prefix, used to build a URL from a bare handle. */
const PROFILE_URL_PREFIX: Record<SocialPlatform, string> = {
	twitter: 'https://twitter.com/',
	bluesky: 'https://bsky.app/profile/',
	telegram: 'https://t.me/',
	furaffinity: 'https://www.furaffinity.net/user/',
	furtrack: 'https://www.furtrack.com/user/',
	deviantart: 'https://www.deviantart.com/',
	patreon: 'https://www.patreon.com/',
	instagram: 'https://www.instagram.com/'
};

/**
 * Normalize a social field into a storable URL, so a bare handle no longer becomes a
 * broken `https://<handle>` link (what sanitizeUrl does on its own).
 *
 * - Empty/blank → '' (unchanged).
 * - Already looks like a URL — an `http(s)://` scheme, a path `/`, or the platform's own
 *   domain — → run through sanitizeUrl, preserving behavior for pasted profile links.
 * - Otherwise treat it as a bare handle: strip a leading `@` and build the canonical
 *   profile URL. A handle that isn't a plausible username (whitespace, a `javascript:`
 *   style scheme, other junk) yields '' rather than a bogus URL.
 *
 * A bare Bluesky handle such as `name.bsky.social` has dots but no scheme/slash/known
 * domain, so it is deliberately treated as a handle → https://bsky.app/profile/name.bsky.social.
 *
 * Patreon creator links come in several spellings (patreon.com/<name>, /c/<name>,
 * /cw/<name>, /join/<name>, /checkout/<name>); a patreon.com URL that names a creator is stored as the one form
 * https://www.patreon.com/<name>, casing kept. One with no creator in it
 * (user?u=<id>, bePatron?u=<id>, posts/<slug>, bare /cw) keeps the sanitizeUrl result.
 */
export function normalizeSocialUrl(
	platform: SocialPlatform,
	input: string | null | undefined
): string {
	if (!input) return '';
	// Same C0+DEL strip, in the same place, as sanitizeUrl — this function repeats
	// that protocol denylist locally, so it has to run on the same string or the
	// two drift: a leading control character is not whitespace, survives trim(),
	// and walks '<NUL>javascript:…' past the check below.
	const trimmed = stripControlChars(input).trim();
	if (!trimmed) return '';

	const lower = trimmed.toLowerCase();
	if (
		lower.startsWith('javascript:') ||
		lower.startsWith('data:') ||
		lower.startsWith('vbscript:')
	) {
		return '';
	}

	const domains = platformDomains(platform);
	const looksLikeUrl =
		lower.startsWith('http://') ||
		lower.startsWith('https://') ||
		trimmed.includes('/') ||
		domains.some((d) => lower.includes(d));
	if (looksLikeUrl) {
		if (platform === 'patreon') {
			const flat = flattenPatreonUrl(trimmed);
			if (flat) return flat;
		}
		return sanitizeUrl(trimmed) ?? '';
	}

	// Bare handle: keep letters, digits, and . _ - (Bluesky handles contain dots).
	const handle = trimmed.replace(/^@+/, '');
	if (!handle || !HANDLE_CHARS.test(handle)) return '';
	return PROFILE_URL_PREFIX[platform] + handle;
}

/** https://www.patreon.com/<name> for a patreon.com URL naming a creator, else ''.
 *  Requires the patreon.com host itself — extractHandle alone would read the first
 *  label of any other host (evil.com/x → "evil.com") as a handle. */
export function flattenPatreonUrl(url: string): string {
	const host = url
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/^\/\//, '')
		.replace(/^www\./, '');
	if (!host.startsWith('patreon.com/')) return '';
	const handle = extractHandle('patreon', url);
	if (!HANDLE_CHARS.test(handle)) return '';
	// '.' and '..' are path navigation, not a creator.
	if (/^\.+$/.test(handle)) return '';
	if (RESERVED_SEGMENTS.patreon?.includes(handle.toLowerCase())) return '';
	const flat = PROFILE_URL_PREFIX.patreon + handle;
	return flat.length > MAX_URL_LENGTH ? '' : flat;
}
