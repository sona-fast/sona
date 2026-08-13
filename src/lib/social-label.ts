// The one way a social account renders as text, everywhere in the app: /about's
// chips, /connect's and /share's link rows, and the registry-search results in
// NewArtistDialog. Three rules, applied uniformly (SONA-128):
//
//  1. Every derived handle is shown with an @ prefix, on every platform and
//     every surface. Bare handles on some platforms and @handles on others was
//     the inconsistency this module retires.
//  2. A URL with no handle in it (a bare `https://instagram.com`, an unset
//     setting, an unparseable string) renders the platform name — "Instagram",
//     never a hostname dressed up as a handle.
//  3. The handle is the FIRST path segment after the platform's profile prefix,
//     not the last, so deep links resolve to the account they belong to:
//     `instagram.com/taro/reels/` → `@taro`, not `@reels`.
//
// Pure and client-safe: no $lib/server imports, so Svelte components can bundle
// it. The prefix table and the extraction itself come from social-platforms,
// which registry matching reads too — that is what keeps display agreeing with
// matching about where a handle starts.

import {
	SOCIAL_HOST_PREFIXES,
	extractHandle,
	platformDomains,
	type SocialPlatform
} from './social-platforms';

export type { SocialPlatform };

/** How each platform's name is written in the UI, including its own casing. */
export const SOCIAL_PLATFORM_NAMES: Record<SocialPlatform, string> = {
	twitter: 'Twitter',
	bluesky: 'Bluesky',
	telegram: 'Telegram',
	furaffinity: 'FurAffinity',
	furtrack: 'FurTrack',
	deviantart: 'DeviantArt',
	patreon: 'Patreon',
	instagram: 'Instagram'
};

/** Percent-decoded, or the raw segment when the escapes are malformed. Non-ASCII
 *  handles arrive encoded in a pathname and should render as themselves. */
function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/** C0/C1 controls, zero-width marks, and the bidi overrides/isolates: the
 *  characters that make a label read as a handle other than the one it is.
 *  Registry socials are proxied unmodified from a remote registry, so a segment
 *  can decode to an RLO and make an admin's search row read as somebody else's
 *  account — art then gets credited to the wrong artist. Mirrors validate.ts's
 *  stripControlChars, widened to the invisibles, and kept here rather than
 *  imported so this module stays client-safe. */
const INVISIBLE_CHARS =
	// eslint-disable-next-line no-control-regex
	/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/** A decoded segment made safe to render: escapes resolved, invisibles removed,
 *  and cut at any delimiter the decoding introduced (`a%2Fb` is not `a/b`). */
function cleanSegment(segment: string): string | null {
	const cleaned = decodeSegment(segment)
		.replace(INVISIBLE_CHARS, '')
		.replace(/^@+/, '')
		.replace(/[/?#].*$/, '');
	return cleaned || null;
}

/**
 * The account handle in `value`, or null when none can be derived.
 *
 * `value` is a stored social setting: normally a profile URL, but a bare handle
 * (`taro`, `@taro`) is accepted too, since registry payloads carry those.
 *
 * Returning a null sentinel — rather than the platform name — lets callers tell
 * "no handle" apart from a real handle that happens to equal the platform name
 * (instagram.com/Instagram is somebody's account).
 */
export function socialHandle(
	platform: SocialPlatform,
	value: string | null | undefined
): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;

	// A bare handle: no scheme and no path to walk. Anything containing a slash
	// goes down the URL path below, so `taro/photos` is not mistaken for one.
	if (!/[:/]/.test(trimmed)) {
		const bare = trimmed.replace(/^@+/, '');
		// Same charset normalizeSocialUrl accepts as a handle (dots included, for
		// Bluesky). Junk that is neither a URL nor a username — "not a url" — is
		// no handle, and rule 2 sends it to the platform name.
		if (!bare || !/^[A-Za-z0-9._-]+$/.test(bare)) return null;
		// …unless it is the platform's own naked domain. `instagram.com` is a
		// scheme-less pathless URL, and rule 2 says that renders "Instagram".
		if (platformDomains(platform).includes(bare.toLowerCase().replace(/^www\./, ''))) return null;
		return bare;
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		// Registry socials are proxied unmodified and can arrive scheme-less with a
		// path ("twitter.com/taro"), which only parses once a scheme is added. A
		// value that already carries a scheme and still fails to parse is junk.
		if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
		try {
			url = new URL(`https://${trimmed}`);
		} catch {
			return null;
		}
	}

	// Match against host+path exactly as extractHandle does — an exact prefix
	// match, longest-listed-first within a platform (patreon.com/c/ before
	// patreon.com/), so the profile prefix is consumed and the handle is what
	// follows it: furaffinity.net/user/taro → taro, bsky.app/profile/x → x.
	const host = url.hostname.toLowerCase().replace(/^www\./, '');
	const hostPath = host + url.pathname;
	const lower = hostPath.toLowerCase();
	const matched = (SOCIAL_HOST_PREFIXES[platform] ?? []).some((p) => lower.startsWith(p));

	// The host is the platform's own but the path is not a profile: /gallery,
	// /search, a bare /user. Rule 2 — a section marker is no more a handle than
	// the hostname is, so the surface falls back to the platform name.
	if (!matched && platformDomains(platform).includes(host)) return null;

	// A host absent from the prefix list is a mirror carrying no prefix of its
	// own, and its first path segment is the profile.
	const segment = matched
		? extractHandle(platform, hostPath)
		: extractHandle(platform, url.pathname.replace(/^\/+/, ''));
	if (!segment) return null;
	return cleanSegment(segment);
}

/**
 * What a social account reads as on screen: `@handle`, or the bare platform
 * name when no handle could be derived.
 */
export function socialLabel(platform: SocialPlatform, value: string | null | undefined): string {
	const handle = socialHandle(platform, value);
	return handle ? `@${handle}` : SOCIAL_PLATFORM_NAMES[platform];
}
