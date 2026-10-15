import { socialHandle } from '$lib/social-label';
import { HOST_PREFIXES, platformDomain, type Platform } from '$lib/social-platforms';
import { normalizeSocialUrl } from './handle-normalize';
import { stripControlChars } from './validate';

// Paste a link (SONA-236): the artist behind a link the owner pasted into a
// commission entry. Nothing here fetches the link. The handle comes from the
// URL's own host and path, so a private chat link never leaves the site, and
// the endpoint can't be pointed at anything.

/** The platforms an artist row has a column for, so a handle can match. */
const PLATFORMS = Object.keys(HOST_PREFIXES) as Platform[];

/** sanitizeUrl's cap: anything longer isn't a link someone pasted. */
const MAX_LINK_LENGTH = 2048;

export type LinkFailure = 'invalid' | 'unsupported' | 'no_handle';

export type ParsedLink =
	| { ok: true; platform: Platform; handle: string; profileUrl: string }
	| { ok: false; reason: LinkFailure };

/**
 * The platform, handle, and profile link a pasted link names.
 *
 * - `invalid`: not a web link at all (plain text, `javascript:`, too long).
 * - `unsupported`: a web link on a host no artist field covers.
 * - `no_handle`: a supported host whose path names no account, such as a
 *   FurAffinity submission, a Patreon post, or a private Telegram channel.
 *
 * `profileUrl` is the account's profile, built from the handle, never the post
 * the owner pasted.
 */
export function parseArtistLink(raw: string): ParsedLink {
	const text = stripControlChars(raw).trim();
	if (!text || text.length > MAX_LINK_LENGTH) return { ok: false, reason: 'invalid' };

	// A link pasted without its scheme ("x.com/taro/status/1") still reads as
	// one, the way the artist fields take it. Anything with a scheme other than
	// http(s) is not a web link.
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
	} catch {
		return { ok: false, reason: 'invalid' };
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'invalid' };
	// A host needs a dot: "artist g bsky" with a scheme added isn't a link.
	if (!url.hostname.includes('.')) return { ok: false, reason: 'invalid' };

	const platform = PLATFORMS.find((p) => platformDomain(p, url.hostname) !== null);
	if (!platform) return { ok: false, reason: 'unsupported' };

	const handle = socialHandle(platform, url.href);
	if (!handle) return { ok: false, reason: 'no_handle' };
	// A handle a profile link can't be built from, such as a Bluesky DID, names
	// no account the owner could have stored, so it's no handle here.
	const profileUrl = normalizeSocialUrl(platform, handle);
	if (!profileUrl) return { ok: false, reason: 'no_handle' };
	return { ok: true, platform, handle, profileUrl };
}
