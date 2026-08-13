// The one way a social account renders as text, everywhere in the app: /about's
// chips, /connect's and /share's link rows, and the registry-search results in
// NewArtistDialog. Three rules, applied uniformly (SONA-128):
//
//  1. Every derived handle is shown with an @ prefix, on every platform and
//     every surface. Some platforms used to show a bare handle and others an
//     @handle; now they all show the @.
//  2. A URL with no handle in it (a bare `https://instagram.com`, one of the
//     platform's own sections, a host the platform does not serve, an unset
//     setting, an unparseable string) renders the platform name — "Instagram",
//     never a hostname or a section marker dressed up as a handle.
//  3. The handle is the FIRST path segment after the platform's profile prefix,
//     not the last, so deep links resolve to the account they belong to:
//     `instagram.com/taro/reels/` → `@taro`, not `@reels`.
//
// Pure and client-safe: no $lib/server imports, so Svelte components can bundle
// it. The prefix table and the extraction itself come from social-platforms,
// which registry matching reads too — that is what keeps display agreeing with
// matching about where a handle starts.

import {
	RESERVED_SEGMENTS,
	extractHandle,
	platformDomain,
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

/** The characters that make a label read as a handle other than the one it is:
 *  the C0/C1 controls, every Unicode format character (\p{Cf} - the bidi overrides
 *  and isolates, the zero-width marks, U+00AD, U+180E, U+2060-2064, U+FEFF, the
 *  U+E0000 tag block), and the invisibles outside that category: the Hangul
 *  fillers, the line/paragraph separators, the variation selectors.
 *  Registry socials are proxied unmodified from a remote registry, so a segment
 *  can decode to an RLO and make an admin's search row read as somebody else's
 *  account — art then gets credited to the wrong artist.
 *  Detected rather than stripped: a stripped handle is a claim about identity the
 *  URL does not support, since twitter.com/ta<ZWSP>ro is a different account from
 *  twitter.com/taro. A segment carrying any of these has no handle we can render
 *  honestly, so rule 2 sends it to the platform name. */
const DECEPTIVE_CHARS =
	// eslint-disable-next-line no-control-regex
	/[\u0000-\u001F\u007F-\u009F\u115F\u1160\u2028\u2029\u3164\uFE00-\uFE0F]|\p{Cf}/u;

/** A decoded segment made safe to render: escapes resolved and cut at any
 *  delimiter the decoding introduced (`a%2Fb` is not `a/b`), or null when it
 *  decodes to something that would misrepresent the account. */
function cleanSegment(segment: string): string | null {
	const decoded = decodeSegment(segment);
	if (DECEPTIVE_CHARS.test(decoded)) return null;
	const cleaned = decoded.replace(/^@+/, '').replace(/[/?#].*$/, '');
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
	// goes down the URL branch below, where `taro/photos` fails the host check
	// and renders the platform name rather than reading as `@photos`.
	if (!/[:/]/.test(trimmed)) {
		const bare = trimmed.replace(/^@+/, '');
		// Same charset normalizeSocialUrl accepts as a handle (dots included, for
		// Bluesky). Junk that is neither a URL nor a username — "not a url" — is
		// no handle, and rule 2 sends it to the platform name.
		if (!bare || !/^[A-Za-z0-9._-]+$/.test(bare)) return null;
		// …unless it is one of the platform's own hosts. `instagram.com` is a
		// scheme-less pathless URL, and rule 2 says that renders "Instagram".
		if (platformDomain(platform, bare)) return null;
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
		// Only text that opens with something host-shaped — dotted, unspaced — is
		// worth a second parse. Retrying everything with a slash in it turns the
		// registry value `n/a` into the host `n` and the handle `a`.
		if (!/^[\w-]+(\.[\w-]+)+(\/|$)/.test(trimmed)) return null;
		try {
			url = new URL(`https://${trimmed}`);
		} catch {
			return null;
		}
	}

	// A handle is only ever read off a host the platform serves. Anything else —
	// a third-party front end, a link filed under the wrong setting — has a path
	// this platform does not define, so its first segment is nobody's handle here
	// and rule 2 renders the platform name.
	const domain = platformDomain(platform, url.hostname);
	if (!domain) return null;

	// The rest is extractHandle's own walk over the canonical host: consume the
	// platform's profile prefix (longest-listed-first, patreon.com/c/ before
	// patreon.com/) and take what follows — furaffinity.net/user/taro → taro,
	// bsky.app/profile/x → x. Handing it the listed domain rather than the real
	// host is what lets a subdomain resolve too: sfw.furaffinity.net/user/taro.
	const extracted = extractHandle(platform, domain + url.pathname);
	// With no prefix consumed, extractHandle stops at the first slash and hands
	// the domain straight back: the path is a section (/gallery, /search, a bare
	// /user), not a profile. Rule 2 again.
	if (!extracted || extracted.toLowerCase() === domain) return null;

	const segment = cleanSegment(extracted);
	if (!segment) return null;
	// Platforms whose profile prefix is the bare domain have nothing in the path
	// to tell an account from a section, so their sections are listed by name:
	// instagram.com/p/<id> is a post, not the account "p".
	if (RESERVED_SEGMENTS[platform]?.includes(segment.toLowerCase())) return null;
	return segment;
}

/**
 * What a social account reads as on screen: `@handle`, or the bare platform
 * name when no handle could be derived.
 */
export function socialLabel(platform: SocialPlatform, value: string | null | undefined): string {
	const handle = socialHandle(platform, value);
	return handle ? `@${handle}` : SOCIAL_PLATFORM_NAMES[platform];
}
