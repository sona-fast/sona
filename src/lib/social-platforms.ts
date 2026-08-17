// Where each platform's profile path starts, and the one algorithm that walks
// it to the handle. Display ($lib/social-label) and registry matching
// (handle-classify's normalizeHandle) both read from here, so they cannot
// disagree about where a handle begins.
//
// Its own module rather than part of handle-classify: the public pages bundle
// these tables through $lib/social-label and have no use for the search
// classifier, which would otherwise ride along into their chunk.
//
// Pure and client-safe: no $lib/server imports.

export type Platform =
	| 'twitter'
	| 'bluesky'
	| 'telegram'
	| 'furaffinity'
	| 'deviantart'
	| 'patreon'
	| 'instagram';

export const HOST_PREFIXES: Record<Platform, string[]> = {
	twitter: ['twitter.com/', 'x.com/', 'mobile.twitter.com/'],
	bluesky: ['bsky.app/profile/', 'staging.bsky.app/profile/'],
	// 't.me/s/<channel>' (Telegram's public channel preview) must be tried before
	// the bare 't.me/' prefix, else every previewed channel collapses to 's'.
	telegram: ['t.me/s/', 't.me/', 'telegram.me/'],
	furaffinity: ['furaffinity.net/user/'],
	deviantart: ['deviantart.com/'],
	// 'patreon.com/c/<user>' (newer creator pages) must be tried before the bare
	// 'patreon.com/' prefix, else the username collapses to 'c'.
	patreon: ['patreon.com/c/', 'patreon.com/'],
	instagram: ['instagram.com/']
};

/**
 * Platforms we render or build profile URLs for. Adds `furtrack` to the
 * registry-matching {@link Platform} set (FurTrack plays no part in registry
 * handle-matching, so it stays out of SOCIAL_KEY_TO_PLATFORM / HOST_PREFIXES).
 */
export type SocialPlatform = Platform | 'furtrack';

/** {@link HOST_PREFIXES} widened to every platform we display a handle for. */
export const SOCIAL_HOST_PREFIXES: Record<SocialPlatform, string[]> = {
	...HOST_PREFIXES,
	furtrack: ['furtrack.com/user/']
};

/** The bare (www-less) hosts a platform's profile URLs live on, read off its
 *  prefix list: 'bsky.app/profile/' → 'bsky.app'. */
export function platformDomains(platform: SocialPlatform): string[] {
	return (SOCIAL_HOST_PREFIXES[platform] ?? []).map((p) => p.replace(/\/.*$/, ''));
}

/**
 * The platform's own domain that `host` belongs to, or null when the host is
 * not the platform's at all.
 *
 * Matched by suffix, not equality, so the subdomains a platform actually serves
 * profiles on come along: `sfw.furaffinity.net/user/taro` is FurAffinity's own
 * host and yields the same handle as the bare domain would. A host the platform
 * does not serve — a third-party front end, or a URL filed under the wrong
 * setting — belongs to nobody here and gets null; its first path segment is not
 * this platform's handle.
 *
 * Listed hosts are checked exactly first: 'mobile.twitter.com' carries a prefix
 * of its own and must not collapse into 'twitter.com'.
 *
 * Only display goes through here. normalizeHandle walks extractHandle over the
 * raw string, so a subdomain URL matches nothing: sfw.furaffinity.net/user/taro
 * DISPLAYS as @taro but MATCHES as 'sfw.furaffinity.net'. Registry-diff then
 * reads such a value as perpetually changed. Fixing that changes what the fork
 * considers a duplicate, so it is deliberately not folded in here.
 */
export function platformDomain(platform: SocialPlatform, host: string): string | null {
	const bare = host.toLowerCase().replace(/^www\./, '');
	const domains = platformDomains(platform);
	return domains.find((d) => bare === d) ?? domains.find((d) => bare.endsWith(`.${d}`)) ?? null;
}

/**
 * True when `host` is one of the profile domains of ANY platform here, whoever
 * it belongs to.
 *
 * The question display asks of a pathless bare token is "is this a hostname",
 * not "is this MY hostname": `twitter.com` stored in the Telegram setting is
 * still a scheme-less pathless URL, and rule 2 says that renders the platform
 * name. Asking only about the current platform read it as the handle
 * `@twitter.com` while the same value with a scheme rendered "Telegram".
 */
export function isSocialDomain(host: string): boolean {
	return (Object.keys(SOCIAL_HOST_PREFIXES) as SocialPlatform[]).some(
		(p) => platformDomain(p, host) !== null
	);
}

/**
 * First path segments that name one of a platform's own sections rather than an
 * account, for the platforms whose profile prefix is the bare domain and so have
 * nothing else to tell the two apart. Instagram's "Copy link" hands out
 * instagram.com/p/<id>; x.com/i/communities/<id> is a community, not a user.
 * Consulted after extraction — a hit is rule 2, a URL with no handle in it.
 */
export const RESERVED_SEGMENTS: Partial<Record<SocialPlatform, string[]>> = {
	instagram: ['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct'],
	twitter: [
		'i',
		'home',
		'search',
		'explore',
		'hashtag',
		'messages',
		'notifications',
		'settings',
		'intent',
		'compose'
	],
	// 'user' is Patreon's legacy profile form, patreon.com/user?u=<id> — the
	// account is in the query string, so the path segment names nobody.
	patreon: ['posts', 'c', 'user', 'login', 'home', 'search', 'explore'],
	deviantart: ['tag', 'art', 'journal', 'search', 'shop', 'daily-deviations'],
	// 'addstickers' matters here beyond tidiness: this repo imports sticker packs
	// from t.me/addstickers/<pack> (see server/telegram.ts), so pasting one into
	// the Telegram setting is a realistic slip, and it read as "@addstickers".
	telegram: ['s', 'joinchat', 'addstickers', 'share', 'proxy']
};

/**
 * The handle in `raw`, with the owner's casing kept, or '' when there is none.
 *
 * Accepts a profile URL, a scheme-less one, or a bare handle: strip the scheme
 * and www., consume the platform's profile prefix (listed longest-first, so
 * patreon.com/c/ wins over patreon.com/), then take everything up to the next
 * delimiter. That first-segment-after-the-prefix rule is what makes
 * furaffinity.net/user/taro/gallery read as `taro` rather than `gallery`.
 */
export function extractHandle(platform: SocialPlatform, raw: string | null | undefined): string {
	if (!raw) return '';
	let s = raw.trim();
	s = s.replace(/^https?:\/\//i, '');
	// Protocol-relative ('//twitter.com/taro'), which registry payloads carry.
	// Left in place it survives the prefix match and the whole value is cut at
	// the first slash, so every such URL normalizes to '' and registry-diff's
	// handleEqual reads two different accounts as unchanged.
	s = s.replace(/^\/\//, '');
	s = s.replace(/^www\./i, '');
	const lower = s.toLowerCase();
	for (const prefix of SOCIAL_HOST_PREFIXES[platform] ?? []) {
		if (lower.startsWith(prefix)) {
			s = s.slice(prefix.length);
			break;
		}
	}
	s = s.replace(/^@+/, '');
	s = s.replace(/[/?#].*$/, '');
	return s;
}
